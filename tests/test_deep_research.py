"""Unit tests for DeepResearchPipeline."""
import asyncio
import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from unittest.mock import AsyncMock, patch, MagicMock
from src.deep_research import DeepResearchPipeline, _DEPTH_PROFILES


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _make_pipeline(llm_responses=None):
    """Create a pipeline with mocked MCP client and optionally mocked LLM."""
    mcp = MagicMock()
    mcp.call_tool = AsyncMock(return_value="mock search result")
    pipeline = DeepResearchPipeline(
        vllm_url="http://localhost:8000/v1",
        model="test-model",
        mcp_client=mcp,
    )
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


# ---------------------------------------------------------------------------
# _estimate_complexity
# ---------------------------------------------------------------------------
def test_estimate_complexity_simple():
    p = _make_pipeline(llm_responses=["simple"])
    result = asyncio.run(p._estimate_complexity("What is 2+2?"))
    assert result == "simple"
    print("[PASS] estimate_complexity simple")


def test_estimate_complexity_fallback():
    p = _make_pipeline(llm_responses=["unknown_garbage"])
    result = asyncio.run(p._estimate_complexity("What is 2+2?"))
    assert result == "medium"
    print("[PASS] estimate_complexity fallback to medium")


# ---------------------------------------------------------------------------
# _decompose
# ---------------------------------------------------------------------------
def test_decompose_splits_lines():
    p = _make_pipeline(llm_responses=["query 1\nquery 2\nquery 3"])
    result = asyncio.run(p._decompose("big question"))
    assert result == ["query 1", "query 2", "query 3"]
    print("[PASS] decompose splits lines")


def test_decompose_skips_empty():
    p = _make_pipeline(llm_responses=["\n\nonly one\n\n"])
    result = asyncio.run(p._decompose("question"))
    assert result == ["only one"]
    print("[PASS] decompose skips empty lines")


# ---------------------------------------------------------------------------
# _search_sub_query (parallel web + memory)
# ---------------------------------------------------------------------------
def test_search_sub_query_returns_dict():
    p = _make_pipeline()
    p.mcp_client.call_tool = AsyncMock(return_value="result data")
    result = asyncio.run(p._search_sub_query("test query"))
    assert result["query"] == "test query"
    assert "result data" in result["web"]
    assert "result data" in result["memory"]
    print("[PASS] search_sub_query returns dict with query/web/memory")


def test_web_search_error_handled():
    p = _make_pipeline()
    p.mcp_client.call_tool = AsyncMock(side_effect=Exception("network error"))
    result = asyncio.run(p._web_search("broken query"))
    assert "error" in result.lower()
    print("[PASS] web_search error handled gracefully")


# ---------------------------------------------------------------------------
# _verify_facts
# ---------------------------------------------------------------------------
def test_verify_facts_updates_context():
    p = _make_pipeline(llm_responses=[
        "ФАКТ: Test fact\nСТАТУС: ПОДТВЕРЖДЁН\nОБОСНОВАНИЕ: Found in sources"
    ])
    assert len(p._research_context) == 0
    asyncio.run(p._verify_facts("question", ["evidence 1", "evidence 2"]))
    assert len(p._research_context) == 1
    assert "Верификация" in p._research_context[0]
    print("[PASS] verify_facts updates research context")


# ---------------------------------------------------------------------------
# _self_critique
# ---------------------------------------------------------------------------
def test_self_critique_returns_text():
    p = _make_pipeline(llm_responses=["Пункт 2 не обоснован."])
    result = asyncio.run(p._self_critique("question", "this is a report"))
    assert "не обоснован" in result
    print("[PASS] self_critique returns critique text")


def test_self_critique_none_means_ok():
    p = _make_pipeline(llm_responses=["none"])
    result = asyncio.run(p._self_critique("question", "good report"))
    assert result.strip().lower() == "none"
    print("[PASS] self_critique 'none' means ok")


# ---------------------------------------------------------------------------
# _final_fact_check
# ---------------------------------------------------------------------------
def test_final_fact_check_parses_json():
    check_json = json.dumps({
        "verified": ["fact A", "fact B"],
        "refuted": ["wrong claim"],
        "corrections": "",
    })
    p = _make_pipeline(llm_responses=[check_json])
    result = asyncio.run(p._final_fact_check("q", "report text", ["ev1"]))
    assert result["verified"] == ["fact A", "fact B"]
    assert result["refuted"] == ["wrong claim"]
    assert result["report"] == "report text"  # corrections empty → keep original
    print("[PASS] final_fact_check parses JSON correctly")


def test_final_fact_check_fallback_on_bad_json():
    p = _make_pipeline(llm_responses=["not valid json at all"])
    result = asyncio.run(p._final_fact_check("q", "original report", ["ev1"]))
    assert result["report"] == "original report"
    assert result["verified"] == []
    assert result["refuted"] == []
    print("[PASS] final_fact_check fallback on invalid JSON")


# ---------------------------------------------------------------------------
# _find_gaps
# ---------------------------------------------------------------------------
def test_find_gaps_returns_queries():
    p = _make_pipeline(llm_responses=["query about gap 1\nquery about gap 2"])
    result = asyncio.run(p._find_gaps("question", "report"))
    assert "gap 1" in result
    assert "gap 2" in result
    print("[PASS] find_gaps returns gap queries")


# ---------------------------------------------------------------------------
# Cumulative context
# ---------------------------------------------------------------------------
def test_cumulative_context_grows():
    p = _make_pipeline()
    assert p._research_context == []
    p._research_context.append("step 1")
    p._research_context.append("step 2")
    assert len(p._research_context) == 2
    print("[PASS] cumulative context grows correctly")


# ---------------------------------------------------------------------------
# Depth profiles
# ---------------------------------------------------------------------------
def test_depth_profiles_exist():
    assert "simple" in _DEPTH_PROFILES
    assert "medium" in _DEPTH_PROFILES
    assert "complex" in _DEPTH_PROFILES
    assert _DEPTH_PROFILES["simple"]["max_iterations"] < _DEPTH_PROFILES["complex"]["max_iterations"]
    print("[PASS] depth profiles exist and are ordered")


# ---------------------------------------------------------------------------
# Full research pipeline (integration mock)
# ---------------------------------------------------------------------------
def test_full_research_pipeline():
    """Integration test: full pipeline with mocked LLM and MCP."""
    responses = [
        "medium",                           # _estimate_complexity
        "sub query 1\nsub query 2",         # _decompose
        "ФАКТ: X\nСТАТУС: ПОДТВЕРЖДЁН",   # _verify_facts
        "# Отчёт\nФакт X подтверждён [1]\n\nИСТОЧНИКИ:\n[1] source",  # _synthesize
        "none",                             # _self_critique
        "none",                             # _find_gaps (no gaps → stop)
        json.dumps({                        # _final_fact_check
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
    assert "refuted_facts" in result
    assert isinstance(result["sources"], list)
    assert result["verified_facts"] == ["X"]
    assert callback.call_count >= 4  # at least 4 status updates
    print("[PASS] full research pipeline integration test")


# ---------------------------------------------------------------------------
# Constructor
# ---------------------------------------------------------------------------
def test_constructor_strips_trailing_slash():
    mcp = MagicMock()
    p = DeepResearchPipeline("http://localhost:8000/v1/", "model", mcp)
    assert p.vllm_url == "http://localhost:8000/v1"
    print("[PASS] constructor strips trailing slash")


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
        except Exception as e:
            print(f"[FAIL] {t.__name__}: {e}")
            failed += 1
    print(f"\n{'='*40}")
    print(f"Total: {passed + failed}, Passed: {passed}, Failed: {failed}")
    if failed:
        sys.exit(1)
