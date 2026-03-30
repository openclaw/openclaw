"""Unit tests for DeepResearchPipeline (v4).

Tests cover the core pipeline, searcher, scraper, and analyzer modules.
All LLM + MCP calls are mocked — no network required.
"""
import asyncio
import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from unittest.mock import AsyncMock, patch, MagicMock
from src.deep_research import (
    DeepResearchPipeline,
    _DEPTH_PROFILES,
    _CONFIDENCE_THRESHOLD,
    EvidencePiece,
    ResearchState,
)
from src.research._scraper import (
    extract_urls_from_search,
    _content_quality_score,
    _url_priority,
    apply_token_budget,
    _TOKEN_BUDGET_TRUNCATION_NOTICE,
)
from src.research._analyzer import (
    score_evidence,
    detect_contradictions,
    estimate_confidence,
    verify_facts,
    final_fact_check,
)
from src.research._searcher import (
    search_sub_query,
    web_search,
    news_search,
    instant_answers,
    memory_search,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _make_pipeline(llm_responses=None):
    """Create a pipeline with mocked MCP client and optionally mocked LLM."""
    mcp = MagicMock()
    mcp.call_tool = AsyncMock(return_value="mock search result")
    pipeline = DeepResearchPipeline(
        model="test-model",
        mcp_client=mcp,
    )
    # Disable academic search in tests (avoids importing research_paper_parser)
    pipeline._academic_search_enabled = False
    pipeline._parsers_enabled = False
    if llm_responses is not None:
        call_count = {"n": 0}
        original_list = list(llm_responses)

        async def _fake_llm(system, user, max_tokens=2048, retries=2):
            idx = call_count["n"]
            call_count["n"] += 1
            if idx < len(original_list):
                return original_list[idx]
            return "none"

        pipeline._llm_call = _fake_llm
    return pipeline


def _make_fake_llm(responses):
    """Create a fake LLM callable that returns responses in order."""
    call_count = {"n": 0}
    original_list = list(responses)

    async def _fake(system, user, max_tokens=2048, retries=2):
        idx = call_count["n"]
        call_count["n"] += 1
        if idx < len(original_list):
            return original_list[idx]
        return "none"
    return _fake


# ---------------------------------------------------------------------------
# _estimate_complexity
# ---------------------------------------------------------------------------
def test_estimate_complexity_simple():
    p = _make_pipeline(llm_responses=["simple"])
    result = asyncio.run(p._estimate_complexity("What is 2+2?"))
    assert result == "simple"


def test_estimate_complexity_fallback():
    p = _make_pipeline(llm_responses=["unknown_garbage"])
    result = asyncio.run(p._estimate_complexity("What is 2+2?"))
    assert result == "medium"


# ---------------------------------------------------------------------------
# _decompose
# ---------------------------------------------------------------------------
def test_decompose_splits_lines():
    p = _make_pipeline(llm_responses=["query 1\nquery 2\nquery 3"])
    result = asyncio.run(p._decompose("big question"))
    assert result == ["query 1", "query 2", "query 3"]


def test_decompose_skips_empty():
    p = _make_pipeline(llm_responses=["\n\nonly one\n\n"])
    result = asyncio.run(p._decompose("question"))
    assert result == ["only one"]


# ---------------------------------------------------------------------------
# Searcher: search_sub_query
# ---------------------------------------------------------------------------
def test_search_sub_query_returns_dict():
    mcp = MagicMock()
    mcp.call_tool = AsyncMock(return_value="result data")
    result = asyncio.run(search_sub_query(
        mcp, "test query", academic_enabled=False, parsers_enabled=False,
        news_enabled=False, multi_region=False,
    ))
    assert result["query"] == "test query"
    assert "result data" in result["web"]


def test_search_sub_query_includes_news():
    mcp = MagicMock()
    mcp.call_tool = AsyncMock(return_value="news data")
    result = asyncio.run(search_sub_query(
        mcp, "test query", academic_enabled=False, parsers_enabled=False,
        news_enabled=True, multi_region=False,
    ))
    assert result.get("news") is not None


def test_search_sub_query_multi_region():
    """v4: multi-region adds RU results to web field."""
    mcp = MagicMock()
    mcp.call_tool = AsyncMock(return_value="global data")
    result = asyncio.run(search_sub_query(
        mcp, "test query", academic_enabled=False, parsers_enabled=False,
        news_enabled=False, multi_region=True,
    ))
    assert "global data" in result["web"]


# ---------------------------------------------------------------------------
# Searcher: web_search
# ---------------------------------------------------------------------------
def test_web_search_error_handled():
    mcp = MagicMock()
    mcp.call_tool = AsyncMock(side_effect=Exception("network error"))
    result = asyncio.run(web_search(mcp, "broken query"))
    assert "error" in result.lower()


def test_web_search_with_region():
    mcp = MagicMock()
    mcp.call_tool = AsyncMock(return_value="ru results")
    result = asyncio.run(web_search(mcp, "test", region="ru-ru"))
    assert "ru results" in result


# ---------------------------------------------------------------------------
# Searcher: news_search
# ---------------------------------------------------------------------------
def test_news_search_success():
    mcp = MagicMock()
    mcp.call_tool = AsyncMock(return_value="breaking news")
    result = asyncio.run(news_search(mcp, "latest events"))
    assert "breaking news" in result


def test_news_search_error():
    mcp = MagicMock()
    mcp.call_tool = AsyncMock(side_effect=Exception("fail"))
    result = asyncio.run(news_search(mcp, "broken"))
    assert result == ""


# ---------------------------------------------------------------------------
# Searcher: instant_answers
# ---------------------------------------------------------------------------
def test_instant_answers_success():
    mcp = MagicMock()
    mcp.call_tool = AsyncMock(return_value="42 is the answer")
    result = asyncio.run(instant_answers(mcp, "meaning of life"))
    assert "42" in result


def test_instant_answers_error():
    mcp = MagicMock()
    mcp.call_tool = AsyncMock(side_effect=Exception("fail"))
    result = asyncio.run(instant_answers(mcp, "broken"))
    assert result == ""


# ---------------------------------------------------------------------------
# Analyzer: score_evidence, contradictions, confidence, verification
# ---------------------------------------------------------------------------
def test_score_evidence():
    llm = _make_fake_llm(["1|9|Very relevant\n2|3|Low relevance"])
    ctx = []
    result = asyncio.run(score_evidence(llm, ctx, "question", ["ev A", "ev B"]))
    assert len(result) == 2
    assert result[0]["score"] == 9.0


def test_score_evidence_empty():
    llm = _make_fake_llm([])
    ctx = []
    result = asyncio.run(score_evidence(llm, ctx, "question", []))
    assert result == []


def test_detect_contradictions():
    llm = _make_fake_llm([
        "ПРОТИВОРЕЧИЕ: Источник A говорит X, а источник B говорит Y"
    ])
    ctx = []
    result = asyncio.run(detect_contradictions(llm, ctx, "q", ["ev1", "ev2"]))
    assert len(result) == 1


def test_detect_contradictions_none():
    llm = _make_fake_llm(["none"])
    ctx = []
    result = asyncio.run(detect_contradictions(llm, ctx, "q", ["ev1", "ev2"]))
    assert result == []


def test_detect_contradictions_single_evidence():
    llm = _make_fake_llm([])
    ctx = []
    result = asyncio.run(detect_contradictions(llm, ctx, "q", ["only one"]))
    assert result == []


def test_estimate_confidence():
    llm = _make_fake_llm(["0.85"])
    result = asyncio.run(estimate_confidence(llm, "q", "report", ["ev1"]))
    assert result == 0.85


def test_estimate_confidence_fallback():
    llm = _make_fake_llm(["not a number"])
    result = asyncio.run(estimate_confidence(llm, "q", "report", ["ev1"]))
    assert result == 0.5


def test_estimate_confidence_clamped():
    llm = _make_fake_llm(["1.5"])
    result = asyncio.run(estimate_confidence(llm, "q", "report", ["ev1"]))
    assert result <= 1.0


def test_verify_facts():
    llm = _make_fake_llm(["ФАКТ: X\nСТАТУС: ПОДТВЕРЖДЁН\nОБОСНОВАНИЕ: Found"])
    ctx = []
    result = asyncio.run(verify_facts(llm, ctx, "question", ["ev1"]))
    assert "Верификация" in ctx[0]


def test_final_fact_check_parses_json():
    check_json = json.dumps({
        "verified": ["fact A"], "refuted": ["wrong"], "corrections": "",
    })
    llm = _make_fake_llm([check_json])
    result = asyncio.run(final_fact_check(llm, "q", "report text", ["ev1"]))
    assert result["verified"] == ["fact A"]
    assert result["report"] == "report text"  # no corrections


def test_final_fact_check_bad_json():
    llm = _make_fake_llm(["not valid json"])
    result = asyncio.run(final_fact_check(llm, "q", "original report", ["ev1"]))
    assert result["report"] == "original report"


# ---------------------------------------------------------------------------
# Scraper: URL extraction + prioritization
# ---------------------------------------------------------------------------
def test_extract_urls_from_search():
    evidence = ["Check https://github.com/foo and https://example.com"]
    urls = extract_urls_from_search(evidence)
    assert len(urls) == 2
    # github should be first due to higher priority
    assert "github.com" in urls[0]


def test_extract_urls_dedup():
    evidence = ["URL: https://a.com", "Also https://a.com"]
    urls = extract_urls_from_search(evidence)
    assert len(urls) == 1


def test_url_priority_known_domains():
    assert _url_priority("https://arxiv.org/abs/123") > _url_priority("https://unknown.xyz/page")
    assert _url_priority("https://github.com/repo") > _url_priority("https://medium.com/post")
    assert _url_priority("https://stackoverflow.com/q/1") >= 9


def test_url_priority_unknown():
    assert _url_priority("https://random-blog.xyz") == 3


# ---------------------------------------------------------------------------
# Scraper: content quality scoring
# ---------------------------------------------------------------------------
def test_content_quality_score_empty():
    assert _content_quality_score("") == 0.0


def test_content_quality_score_good_content():
    content = (
        "# Deep Learning Overview\n\n"
        "This is a comprehensive article about deep learning.\n\n"
        "## Architecture\n\nNeural networks consist of layers...\n\n"
        "```python\nimport torch\n```\n\n"
        "## Training\n\nTraining involves...\n\n" * 10
    )
    score = _content_quality_score(content)
    assert score > 0.5, f"Good content should score > 0.5, got {score}"


def test_content_quality_score_junk():
    content = "Sign in to continue. Cookie policy. 403 Forbidden. Subscribe now."
    score = _content_quality_score(content)
    assert score < 0.3, f"Junk content should score low, got {score}"


# ---------------------------------------------------------------------------
# Scraper: token budget
# ---------------------------------------------------------------------------
def test_apply_token_budget_within_limit():
    evidence = ["short block 1", "short block 2"]
    result = apply_token_budget(evidence)
    assert "short block 1" in result
    assert "short block 2" in result
    assert _TOKEN_BUDGET_TRUNCATION_NOTICE not in result


def test_apply_token_budget_truncates():
    # Create evidence that exceeds budget
    big_block = "x" * 50_000
    evidence = [big_block, big_block, big_block]
    result = apply_token_budget(evidence)
    assert _TOKEN_BUDGET_TRUNCATION_NOTICE in result


# ---------------------------------------------------------------------------
# EvidencePiece and ResearchState
# ---------------------------------------------------------------------------
def test_evidence_piece_summary():
    ep = EvidencePiece(query="test", source_type="web", content="a" * 1000)
    assert len(ep.summary(200)) == 200


def test_evidence_piece_default_confidence():
    ep = EvidencePiece(query="test", source_type="memory", content="data")
    assert ep.confidence == 0.5


def test_research_state_evidence_count():
    state = ResearchState(question="test")
    assert state.evidence_count == 0
    state.add_evidence(EvidencePiece(query="q1", source_type="web", content="data"))
    assert state.evidence_count == 1


def test_research_state_source_diversity():
    state = ResearchState(question="test")
    state.add_evidence(EvidencePiece(query="q1", source_type="web", content="a"))
    state.add_evidence(EvidencePiece(query="q2", source_type="memory", content="b"))
    state.add_evidence(EvidencePiece(query="q3", source_type="academic", content="c"))
    state.add_evidence(EvidencePiece(query="q4", source_type="news", content="d"))
    assert state.source_diversity == 4


def test_research_state_add_evidence_tracks_sources():
    state = ResearchState(question="test")
    state.add_evidence(EvidencePiece(query="q1", source_type="web", content="real data"))
    assert "q1" in state.sources
    state.add_evidence(EvidencePiece(query="q2", source_type="web", content="No results found."))
    assert "q2" not in state.sources


# ---------------------------------------------------------------------------
# Multi-perspective reformulation
# ---------------------------------------------------------------------------
def test_reformulate_queries():
    p = _make_pipeline(llm_responses=["alt perspective 1\nalt perspective 2"])
    result = asyncio.run(p._reformulate_queries("question", ["query 1", "query 2"]))
    assert isinstance(result, list)
    assert len(result) <= 2


def test_reformulate_queries_empty():
    p = _make_pipeline(llm_responses=["alt"])
    result = asyncio.run(p._reformulate_queries("question", []))
    assert result == []


# ---------------------------------------------------------------------------
# Self-critique
# ---------------------------------------------------------------------------
def test_self_critique_returns_text():
    p = _make_pipeline(llm_responses=["Пункт 2 не обоснован."])
    result = asyncio.run(p._self_critique("question", "this is a report"))
    assert "не обоснован" in result


def test_self_critique_none_means_ok():
    p = _make_pipeline(llm_responses=["none"])
    result = asyncio.run(p._self_critique("question", "good report"))
    assert result.strip().lower() == "none"


# ---------------------------------------------------------------------------
# Depth profiles + confidence threshold
# ---------------------------------------------------------------------------
def test_depth_profiles_exist():
    assert "simple" in _DEPTH_PROFILES
    assert "medium" in _DEPTH_PROFILES
    assert "complex" in _DEPTH_PROFILES
    assert _DEPTH_PROFILES["simple"]["max_iterations"] < _DEPTH_PROFILES["complex"]["max_iterations"]


def test_confidence_threshold_exists():
    assert isinstance(_CONFIDENCE_THRESHOLD, float)
    assert 0.0 < _CONFIDENCE_THRESHOLD < 1.0


# ---------------------------------------------------------------------------
# Cumulative context
# ---------------------------------------------------------------------------
def test_cumulative_context_grows():
    p = _make_pipeline()
    assert p._research_context == []
    p._research_context.append("step 1")
    p._research_context.append("step 2")
    assert len(p._research_context) == 2


# ---------------------------------------------------------------------------
# Full research pipeline (integration mock)
# ---------------------------------------------------------------------------
def test_full_research_pipeline():
    """Integration test: full pipeline with mocked LLM and MCP."""
    responses = [
        "medium",                           # _estimate_complexity
        "sub query 1\nsub query 2",         # _decompose
        "alt query 1\nalt query 2",         # _reformulate_queries
        "1|8|Relevant\n2|6|Partially relevant",  # score_evidence
        "none",                             # detect_contradictions
        "ФАКТ: X\nСТАТУС: ПОДТВЕРЖДЁН",   # verify_facts
        "# Отчёт\nФакт X подтверждён [1]\n\nИСТОЧНИКИ:\n[1] source",  # _synthesize
        "none",                             # _self_critique
        "0.85",                             # estimate_confidence (adaptive stop)
        "0.90",                             # estimate_confidence (final calibration)
        json.dumps({                        # final_fact_check
            "verified": ["X"],
            "refuted": [],
            "corrections": "",
        }),
    ]
    p = _make_pipeline(llm_responses=responses)
    callback = AsyncMock()

    result = asyncio.run(p.research("What is X?", status_callback=callback))

    assert "report" in result
    assert "sources" in result
    assert "iterations" in result
    assert "verified_facts" in result
    assert "confidence_score" in result
    assert "evidence_count" in result
    assert "source_diversity" in result
    assert "contradictions" in result
    assert isinstance(result["confidence_score"], float)
    assert callback.call_count >= 4


# ---------------------------------------------------------------------------
# Run all
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            passed += 1
            print(f"[PASS] {t.__name__}")
        except Exception as e:
            print(f"[FAIL] {t.__name__}: {e}")
            failed += 1
    print(f"\n{'='*40}")
    print(f"Total: {passed + failed}, Passed: {passed}, Failed: {failed}")
    if failed:
        sys.exit(1)
