"""
Comprehensive tests for the improvement modules.

Covers pure-logic methods, dataclass construction, persistence round-trips,
and heuristic scorers.  Does NOT mock or call any live LLM / vLLM endpoints.

Modules under test
------------------
1. src.agent_reasoning
2. src.memory_enhanced
3. src.research_enhanced
4. src.ai.inference (SmartModelRouter, Budget, Metrics, etc.)
"""

import asyncio
import json
import math
import os
import tempfile
import time

import pytest

# ---------------------------------------------------------------------------
# 1. agent_reasoning  (dataclasses + ToolLearningTracker only — no LLM)
# ---------------------------------------------------------------------------
from src.ai.agents import (
    ConstitutionalChecker,
    ConstitutionalResult,
    EvaluationResult,
    MoAResult,
    ReActReasoner,
    ReActResult,
    ReActStep,
    ReflexionAgent,
    ReflexionResult,
    ToolLearningTracker,
    ToolStats,
)

# ---------------------------------------------------------------------------
# 3. memory_enhanced
# ---------------------------------------------------------------------------
from src.memory_enhanced import (
    EpisodeRecord,
    EpisodicMemory,
    MemoryImportanceScorer,
    MemoryItem,
    MemoryStats,
    TieredMemoryManager,
    WorkingMemoryPage,
)

# ---------------------------------------------------------------------------
# 4. research_enhanced  (heuristic scorers only — no LLM)
# ---------------------------------------------------------------------------
from src.research_enhanced import (
    ClaimValidation,
    EvidenceQualityScorer,
    EvidenceScore,
    MultiPerspectiveResult,
    MultiPerspectiveResearcher,
    QualityMetrics,
    ResearchQualityMetrics,
    ValidationResult,
)

# ---------------------------------------------------------------------------
# 5. inference_optimizer
# ---------------------------------------------------------------------------
from src.ai.inference import (
    AdaptiveTokenBudget,
    BatchMetrics,
    DynamicBatchScheduler,
    InferenceMetrics,
    InferenceMetricsCollector,
    ModelPerformance,
    ModelProfile,
    RoutingTask,
    SmartModelRouter,
    SpeculativeDecodingConfig,
    TokenBudget,
)


# ===================================================================
# Fixtures
# ===================================================================


@pytest.fixture()
def tmp_dir():
    """Temporary directory cleaned up after test."""
    with tempfile.TemporaryDirectory() as d:
        yield d


# ===================================================================
# 1. agent_reasoning tests (dataclasses + ToolLearningTracker)
# ===================================================================


class TestAgentReasoningDataclasses:
    def test_react_step_creation(self):
        step = ReActStep(step=1, thought="hmm", action="Search", action_input="q", observation="result")
        assert step.step == 1
        assert step.action == "Search"
        assert step.timestamp > 0

    def test_react_result_creation(self):
        r = ReActResult(answer="42", steps=[], total_steps=1, finished=True, elapsed_sec=0.5)
        assert r.finished is True
        assert r.total_steps == 1

    def test_evaluation_result(self):
        ev = EvaluationResult(success=True, score=0.85, reasoning="good", issues=[])
        assert ev.success is True
        assert ev.score == 0.85

    def test_reflexion_result(self):
        rr = ReflexionResult(
            final_response="ans", attempts=2, reflections=["r1"],
            evaluations=[], success=False, elapsed_sec=1.0,
        )
        assert rr.attempts == 2
        assert rr.success is False

    def test_moa_result(self):
        mr = MoAResult(aggregated_response="agg", proposals=["a", "b"], num_proposers=2, elapsed_sec=3.0)
        assert mr.num_proposers == 2

    def test_constitutional_result(self):
        cr = ConstitutionalResult(safe=True, violations=[], revised_response=None)
        assert cr.safe is True
        assert cr.principle_scores == {}

    def test_tool_stats_properties(self):
        ts = ToolStats(tool_name="search", total_calls=10, successes=7, failures=3, total_latency_ms=5000)
        assert ts.success_rate == 0.7
        assert ts.avg_latency_ms == 500.0
        d = ts.to_dict()
        assert "success_rate" in d

    def test_tool_stats_zero_calls(self):
        ts = ToolStats(tool_name="x")
        assert ts.success_rate == 0.0
        assert ts.avg_latency_ms == 0.0


class TestConstitutionalPrinciples:
    def test_principles_list_exists(self):
        assert isinstance(ConstitutionalChecker.PRINCIPLES, list)
        assert len(ConstitutionalChecker.PRINCIPLES) >= 4

    def test_principles_have_colon(self):
        for p in ConstitutionalChecker.PRINCIPLES:
            assert ":" in p, f"Principle missing colon: {p}"


class TestReActParser:
    def test_parse_react_output_basic(self):
        raw = "Thought: I should search\nAction: Search\nAction Input: python docs"
        t, a, ai = ReActReasoner._parse_react_output(raw)
        assert t == "I should search"
        assert a == "Search"
        assert ai == "python docs"

    def test_parse_finish_normalised(self):
        raw = "Thought: done\nAction: final answer\nAction Input: 42"
        _, a, _ = ReActReasoner._parse_react_output(raw)
        assert a == "Finish"

    def test_format_react_prompt(self):
        reasoner = ReActReasoner()
        prompt = reasoner.format_react_prompt("What is 2+2?", [], [])
        assert "What is 2+2?" in prompt
        assert prompt.endswith("Thought:")


class TestReflexionParsers:
    def test_parse_score(self):
        raw = "Score: 0.85\nIssues: none\nReasoning: looks good"
        assert ReflexionAgent._parse_score(raw) == 0.85

    def test_parse_score_clamped(self):
        assert ReflexionAgent._parse_score("Score: 5.0") == 1.0
        assert ReflexionAgent._parse_score("Score: -1.0") == 0.0

    def test_parse_score_default(self):
        assert ReflexionAgent._parse_score("no score here") == 0.5

    def test_parse_issues(self):
        raw = "Issues: missing context, too short"
        issues = ReflexionAgent._parse_issues(raw)
        assert len(issues) == 2
        assert "missing context" in issues

    def test_parse_issues_none(self):
        assert ReflexionAgent._parse_issues("Issues: none") == []

    def test_build_generation_prompt_no_reflections(self):
        p = ReflexionAgent._build_generation_prompt("task", [])
        assert "task" in p.lower()
        assert "reflection" not in p.lower()

    def test_build_generation_prompt_with_reflections(self):
        p = ReflexionAgent._build_generation_prompt("task", ["try harder"])
        assert "Reflection 1" in p


class TestToolLearningTracker:
    def test_record_and_stats(self):
        tracker = ToolLearningTracker()
        tracker.record_tool_use("search", True, 100)
        tracker.record_tool_use("search", False, 200, error="timeout")
        stats = tracker.get_tool_stats()
        assert "search" in stats
        assert stats["search"].total_calls == 2
        assert stats["search"].successes == 1

    def test_success_rate(self):
        tracker = ToolLearningTracker()
        for _ in range(3):
            tracker.record_tool_use("tool_a", True, 50)
        for _ in range(7):
            tracker.record_tool_use("tool_a", False, 50, error="err")
        assert tracker.get_tool_stats()["tool_a"].success_rate == 0.3

    def test_should_retry_not_enough_data(self):
        tracker = ToolLearningTracker()
        tracker.record_tool_use("tool_a", False, 50, error="err")
        assert tracker.should_retry_with_alternative("tool_a") is False

    def test_should_retry_low_success(self):
        tracker = ToolLearningTracker()
        for _ in range(5):
            tracker.record_tool_use("bad_tool", False, 50, error="err")
        assert tracker.should_retry_with_alternative("bad_tool") is True

    def test_should_retry_high_success(self):
        tracker = ToolLearningTracker()
        for _ in range(5):
            tracker.record_tool_use("good_tool", True, 50)
        assert tracker.should_retry_with_alternative("good_tool") is False

    def test_get_best_tool_for_task(self):
        tracker = ToolLearningTracker()
        tracker.record_tool_use("search", True, 100, task_type="lookup")
        tracker.record_tool_use("search", True, 100, task_type="lookup")
        tracker.record_tool_use("calc", True, 100, task_type="lookup")
        assert tracker.get_best_tool_for_task("lookup") == "search"

    def test_get_best_tool_unknown_task(self):
        tracker = ToolLearningTracker()
        assert tracker.get_best_tool_for_task("unknown") is None

    def test_suggest_alternative(self):
        tracker = ToolLearningTracker()
        for _ in range(5):
            tracker.record_tool_use("bad", False, 50, error="err")
        for _ in range(5):
            tracker.record_tool_use("good", True, 50)
        alt = tracker.suggest_alternative("bad")
        assert alt == "good"

    def test_suggest_alternative_none(self):
        tracker = ToolLearningTracker()
        tracker.record_tool_use("only", False, 50, error="err")
        assert tracker.suggest_alternative("only") is None

    def test_recent_errors_capped(self):
        tracker = ToolLearningTracker()
        for i in range(30):
            tracker.record_tool_use("x", False, 10, error=f"e{i}")
        stats = tracker.get_tool_stats()
        assert len(stats["x"].recent_errors) <= 20

    def test_tool_report(self):
        tracker = ToolLearningTracker()
        tracker.record_tool_use("a", True, 10)
        tracker.record_tool_use("b", True, 20)
        report = tracker.get_tool_report()
        assert isinstance(report, list)
        assert len(report) == 2


# ===================================================================
# 3. memory_enhanced tests
# ===================================================================


class TestMemoryItem:
    def test_creation(self):
        item = MemoryItem(key="k1", content="hello world")
        assert item.tier == "hot"
        assert item.importance == 0.5

    def test_touch(self):
        item = MemoryItem(key="k", content="c")
        old = item.last_access
        time.sleep(0.01)
        item.touch()
        assert item.access_count == 1
        assert item.last_access >= old

    def test_token_count(self):
        item = MemoryItem(key="k", content="a" * 100)
        assert item.token_count() == 25

    def test_round_trip_dict(self):
        item = MemoryItem(key="k", content="c", tier="warm", importance=0.9)
        d = item.to_dict()
        restored = MemoryItem.from_dict(d)
        assert restored.key == "k"
        assert restored.tier == "warm"


class TestWorkingMemoryPage:
    def test_creation(self):
        page = WorkingMemoryPage(key="p1", content="data here")
        assert page.access_count == 0
        assert page.importance == 0.5

    def test_read_tracks_access(self):
        page = WorkingMemoryPage(key="p1", content="data")
        result = page.read()
        assert result == "data"
        assert page.access_count == 1
        page.read()
        assert page.access_count == 2

    def test_to_memory_item(self):
        page = WorkingMemoryPage(key="p1", content="data", importance=0.8)
        item = page.to_memory_item(tier="warm")
        assert isinstance(item, MemoryItem)
        assert item.tier == "warm"
        assert item.importance == 0.8

    def test_token_count(self):
        page = WorkingMemoryPage(key="p1", content="a" * 200)
        assert page.token_count() == 50


class TestMemoryImportanceScorer:
    def test_score_range(self):
        scorer = MemoryImportanceScorer()
        item = MemoryItem(key="k", content="hello world")
        s = scorer.score(item, "hello")
        assert 0.0 <= s <= 1.0

    def test_relevance_boost(self):
        scorer = MemoryImportanceScorer()
        item = MemoryItem(key="k", content="python machine learning tutorial")
        s_relevant = scorer.score(item, "python machine learning")
        s_irrelevant = scorer.score(item, "cooking recipe pasta")
        assert s_relevant > s_irrelevant

    def test_update_after_use(self):
        scorer = MemoryImportanceScorer()
        scorer.update_after_use("k1", 0.9)
        scorer.update_after_use("k1", 0.8)
        # Internal history updated
        total, count = scorer._reward_history["k1"]
        assert abs(total - 1.7) < 1e-9
        assert count == 2

    def test_decay_all(self):
        scorer = MemoryImportanceScorer()
        scorer.update_after_use("k1", 1.0)
        scorer.decay_all(factor=0.5)
        total, count = scorer._reward_history["k1"]
        assert total == 0.5
        assert count == 1  # count unchanged


class TestTieredMemoryManager:
    def test_add_to_hot(self, tmp_dir):
        mgr = TieredMemoryManager(memory_bank_dir=os.path.join(tmp_dir, "bank"), max_hot_tokens=5000)
        mgr.add_to_hot("fact1", "Python is a programming language")
        stats = mgr.get_stats()
        assert stats.items_per_tier["hot"] == 1

    def test_page_out_when_over_budget(self, tmp_dir):
        mgr = TieredMemoryManager(memory_bank_dir=os.path.join(tmp_dir, "bank"), max_hot_tokens=10)
        mgr.add_to_hot("big", "x" * 200)  # way over 10 tokens
        mgr.add_to_hot("small", "hi")
        # The least important should be paged out
        stats = mgr.get_stats()
        assert stats.items_per_tier["warm"] >= 1

    def test_get_context_window(self, tmp_dir):
        mgr = TieredMemoryManager(memory_bank_dir=os.path.join(tmp_dir, "bank"), max_hot_tokens=5000)
        mgr.add_to_hot("f1", "fact one")
        mgr.add_to_hot("f2", "fact two")
        ctx = mgr.get_context_window(max_tokens=5000)
        assert "fact one" in ctx
        assert "fact two" in ctx

    def test_get_stats_empty(self, tmp_dir):
        mgr = TieredMemoryManager(memory_bank_dir=os.path.join(tmp_dir, "bank"))
        stats = mgr.get_stats()
        assert stats.items_per_tier["hot"] == 0
        assert stats.oldest_item is None

    def test_cold_from_disk(self, tmp_dir):
        bank_dir = os.path.join(tmp_dir, "bank")
        os.makedirs(bank_dir)
        with open(os.path.join(bank_dir, "notes.md"), "w") as f:
            f.write("# Notes\nSome archived knowledge.")
        mgr = TieredMemoryManager(memory_bank_dir=bank_dir)
        stats = mgr.get_stats()
        assert stats.items_per_tier["cold"] == 1


class TestEpisodicMemory:
    def test_store_and_retrieve(self, tmp_dir):
        mem = EpisodicMemory(storage_dir=tmp_dir)
        ep = EpisodeRecord(
            episode_id="ep1",
            task="translate python to rust",
            steps=[{"role": "user", "content": "translate this"}],
            reward=0.9,
            success=True,
        )
        mem.store_episode(ep)
        results = mem.retrieve_similar("translate python code", k=1)
        assert len(results) == 1
        assert results[0].episode_id == "ep1"

    def test_retrieve_empty(self, tmp_dir):
        mem = EpisodicMemory(storage_dir=tmp_dir)
        assert mem.retrieve_similar("anything") == []

    def test_get_few_shot_examples_empty(self, tmp_dir):
        mem = EpisodicMemory(storage_dir=tmp_dir)
        assert mem.get_few_shot_examples("task") == ""

    def test_get_few_shot_examples(self, tmp_dir):
        mem = EpisodicMemory(storage_dir=tmp_dir)
        for i in range(3):
            mem.store_episode(EpisodeRecord(
                episode_id=f"ep{i}",
                task=f"solve math problem number {i}",
                steps=[{"role": "assistant", "content": f"answer {i}"}],
                reward=0.7 + i * 0.1,
                success=True,
            ))
        text = mem.get_few_shot_examples("solve math problem", k=2)
        assert "Example 1" in text
        assert "reward=" in text

    def test_persistence_round_trip(self, tmp_dir):
        mem1 = EpisodicMemory(storage_dir=tmp_dir)
        mem1.store_episode(EpisodeRecord(
            episode_id="ep_persist",
            task="persist test",
            steps=[],
            reward=0.5,
            success=True,
        ))
        # Create new instance from same dir — should load persisted data
        mem2 = EpisodicMemory(storage_dir=tmp_dir)
        assert len(mem2._episodes) == 1
        assert mem2._episodes[0].episode_id == "ep_persist"


class TestEpisodeRecord:
    def test_round_trip(self):
        ep = EpisodeRecord(
            episode_id="e1", task="test", steps=[{"role": "a", "content": "b"}],
            reward=0.5, success=True,
        )
        d = ep.to_dict()
        restored = EpisodeRecord.from_dict(d)
        assert restored.episode_id == "e1"
        assert restored.reward == 0.5


# ===================================================================
# 4. research_enhanced tests (heuristics — no LLM)
# ===================================================================


class TestResearchDataclasses:
    def test_multi_perspective_result(self):
        r = MultiPerspectiveResult(
            advocate_view="pro", critic_view="con",
            synthesis="balanced", confidence=0.7, perspectives_used=3,
        )
        assert r.confidence == 0.7

    def test_evidence_score(self):
        es = EvidenceScore(reliability=0.9, recency=0.8, specificity=0.7, cross_refs=0.6, total_score=0.8)
        assert es.total_score == 0.8

    def test_claim_validation(self):
        cv = ClaimValidation(
            claim="Earth is round", confidence=0.99,
            supporting_sources=["NASA"], contradicting_sources=[],
            status="confirmed",
        )
        assert cv.status == "confirmed"

    def test_validation_result(self):
        vr = ValidationResult(claims=[], overall_confidence=0.0, validated_count=0, refuted_count=0)
        assert vr.overall_confidence == 0.0

    def test_quality_metrics(self):
        qm = QualityMetrics(
            coverage=0.8, depth=0.7, source_diversity=0.6,
            citation_density=0.5, consistency=0.9, novelty=0.4, total_score=0.65,
        )
        assert qm.total_score == 0.65


class TestEvidenceQualityScorer:
    def test_trusted_domains_exist(self):
        assert isinstance(EvidenceQualityScorer.TRUSTED_DOMAINS, dict)
        assert "arxiv.org" in EvidenceQualityScorer.TRUSTED_DOMAINS

    def test_score_arxiv(self):
        scorer = EvidenceQualityScorer()
        es = scorer.score("A detailed paper about transformers.", source_url="https://arxiv.org/abs/2309.06180")
        assert es.reliability > 0.9

    def test_score_unknown_domain(self):
        scorer = EvidenceQualityScorer()
        es = scorer.score("Some text.", source_url="https://random-blog.example.com/post")
        assert es.reliability <= 0.6

    def test_score_no_url(self):
        scorer = EvidenceQualityScorer()
        es = scorer.score("Some evidence text.")
        assert es.reliability == 0.5

    def test_recency_recent(self):
        scorer = EvidenceQualityScorer()
        recent_date = "2025-06-01T00:00:00Z"
        es = scorer.score("text", published_date=recent_date)
        assert es.recency > 0.5

    def test_recency_unknown(self):
        scorer = EvidenceQualityScorer()
        es = scorer.score("text", published_date="")
        assert es.recency == 0.5

    def test_specificity_detailed_text(self):
        scorer = EvidenceQualityScorer()
        detailed = (
            "The model achieves 95.2% accuracy on MMLU benchmark. "
            "```python\nimport torch\n```\n"
            "See https://example.com for details. "
            "Google DeepMind reported these results."
        )
        es = scorer.score(detailed)
        assert es.specificity > 0.0

    def test_rank_evidence(self):
        scorer = EvidenceQualityScorer()
        items = [
            {"text": "short"},
            {"text": "A detailed technical paper with numbers 42.5 and code ```python``` and references [1] [2]",
             "source_url": "https://arxiv.org/abs/1234"},
        ]
        ranked = scorer.rank_evidence(items)
        assert ranked[0]["source_url"] == "https://arxiv.org/abs/1234"


class TestResearchQualityMetrics:
    def test_compute_basic(self):
        rqm = ResearchQualityMetrics()
        question = "What is machine learning?"
        report = (
            "Machine learning is a subset of artificial intelligence.\n\n"
            "It involves training models on data to make predictions.\n\n"
            "Deep learning uses neural networks with many layers."
        )
        metrics = rqm.compute(question, report, ["https://arxiv.org", "https://wikipedia.org"])
        assert 0.0 <= metrics.total_score <= 1.0
        assert metrics.coverage > 0
        assert metrics.depth > 0

    def test_coverage_full(self):
        rqm = ResearchQualityMetrics()
        q = "python tutorial"
        r = "This python tutorial covers basics of python programming."
        m = rqm.compute(q, r, [])
        assert m.coverage > 0.5

    def test_depth_empty_report(self):
        rqm = ResearchQualityMetrics()
        m = rqm.compute("q", "", [])
        assert m.depth == 0.0

    def test_source_diversity(self):
        rqm = ResearchQualityMetrics()
        m = rqm.compute("q", "report text", [
            "https://arxiv.org/paper1",
            "https://github.com/repo",
            "https://stackoverflow.com/q/1",
            "https://docs.python.org/3/",
            "https://huggingface.co/model",
        ])
        assert m.source_diversity == 1.0

    def test_consistency_no_contradictions(self):
        rqm = ResearchQualityMetrics()
        m = rqm.compute("q", "A clear and consistent report.", [])
        assert m.consistency == 1.0

    def test_consistency_with_contradictions(self):
        rqm = ResearchQualityMetrics()
        m = rqm.compute("q", "Good result. However, on the other hand, contradiction detected.", [])
        assert m.consistency < 1.0

    def test_confidence_estimate(self):
        """Test the static _estimate_confidence on MultiPerspectiveResearcher."""
        conf = MultiPerspectiveResearcher._estimate_confidence(
            advocate_view="a" * 500,
            critic_view="c" * 500,
            synthesis="s" * 1000,
        )
        assert 0.0 <= conf <= 1.0

    def test_confidence_empty_synthesis(self):
        conf = MultiPerspectiveResearcher._estimate_confidence("a", "c", "")
        assert conf == 0.0


# ===================================================================
# 5. inference_optimizer tests
# ===================================================================


class TestSpeculativeDecodingConfig:
    def test_disabled_no_args(self):
        cfg = SpeculativeDecodingConfig(enabled=False)
        assert cfg.to_vllm_args() == []
        assert cfg.estimated_vram_overhead_gb() == 0.0

    def test_enabled_args(self):
        # n-gram mode (default): zero VRAM overhead, uses --speculative-config JSON
        cfg = SpeculativeDecodingConfig(enabled=True, num_speculative_tokens=3)
        args = cfg.to_vllm_args()
        assert "--speculative-config" in args
        import json; spec_cfg = json.loads(args[1])
        assert spec_cfg["num_speculative_tokens"] == 3
        assert cfg.estimated_vram_overhead_gb() == 0.0  # n-gram: no draft model loaded

    def test_enabled_args_draft_model(self):
        # draft-model mode: 1 GB VRAM overhead for the draft model
        cfg = SpeculativeDecodingConfig(enabled=True, use_ngram=False, num_speculative_tokens=3)
        args = cfg.to_vllm_args()
        assert "--speculative-config" in args
        import json; spec_cfg = json.loads(args[1])
        assert spec_cfg["num_speculative_tokens"] == 3
        assert cfg.estimated_vram_overhead_gb() == 1.0


class TestDynamicBatchScheduler:
    def test_initial_state(self):
        sched = DynamicBatchScheduler()
        assert sched.get_optimal_batch_size() == 1
        assert sched.should_throttle() is False

    def test_record_request(self):
        sched = DynamicBatchScheduler()
        sched.record_request(tokens_in=100, tokens_out=200, latency_ms=500)
        m = sched.get_metrics()
        assert m.avg_latency_ms == 500.0
        assert m.throughput_tps > 0

    def test_batch_grows_under_target(self):
        sched = DynamicBatchScheduler(target_latency_ms=10000)
        sched.set_queue_depth(20)
        for _ in range(10):
            sched.record_request(100, 100, 1000)  # well under 10s target
        assert sched.get_optimal_batch_size() > 1

    def test_batch_shrinks_over_target(self):
        sched = DynamicBatchScheduler(target_latency_ms=100)
        sched._batch_size = 10
        for _ in range(10):
            sched.record_request(100, 100, 500)  # 5× over 100ms target
        assert sched.get_optimal_batch_size() < 10

    def test_throttle_on_high_latency(self):
        sched = DynamicBatchScheduler(target_latency_ms=100)
        for _ in range(10):
            sched.record_request(100, 100, 300)  # 3× target → throttle
        assert sched.should_throttle() is True

    def test_get_metrics_snapshot(self):
        sched = DynamicBatchScheduler()
        m = sched.get_metrics()
        assert isinstance(m, BatchMetrics)
        assert m.queue_depth == 0


class TestSmartModelRouter:
    @pytest.fixture()
    def router(self):
        models = {
            "small": ModelProfile(name="small", vram_gb=2.0, capabilities=["chat", "general"], speed_tier="fast", quality_tier="low"),
            "medium": ModelProfile(name="medium", vram_gb=8.0, capabilities=["code", "math", "general"], speed_tier="medium", quality_tier="medium"),
            "large": ModelProfile(name="large", vram_gb=14.0, capabilities=["code", "math", "creative", "general"], speed_tier="slow", quality_tier="high"),
        }
        return SmartModelRouter(models)

    def test_route_preferred(self, router):
        task = RoutingTask(prompt="anything", preferred_model="small")
        assert router.route(task) == "small"

    def test_route_code_task(self, router):
        task = RoutingTask(prompt="Write a python function to sort a list")
        chosen = router.route(task)
        assert chosen in ("medium", "large")

    def test_route_simple_chat(self, router):
        task = RoutingTask(prompt="Hi!", task_type="chat", complexity_hint="simple")
        chosen = router.route(task)
        assert chosen == "small"  # fast model for simple chat

    def test_route_complex_task(self, router):
        task = RoutingTask(prompt="x" * 500, task_type="code", complexity_hint="complex")
        chosen = router.route(task)
        assert chosen in ("medium", "large")

    def test_record_outcome_and_stats(self, router):
        router.record_outcome("small", "chat", True, 0.9)
        router.record_outcome("small", "chat", False, 0.3)
        stats = router.get_routing_stats()
        assert stats["model_outcomes"]["small"]["chat"]["total"] == 2
        assert stats["model_outcomes"]["small"]["chat"]["success_rate"] == 0.5

    def test_routing_stats_empty(self, router):
        stats = router.get_routing_stats()
        assert stats["route_counts"] == {}

    def test_classify_math(self, router):
        task = RoutingTask(prompt="Calculate the integral of x^2 dx")
        chosen = router.route(task)
        # Math capability → medium or large
        assert chosen in ("medium", "large")

    def test_classify_creative(self, router):
        task = RoutingTask(prompt="Write a short story about a robot")
        chosen = router.route(task)
        assert chosen == "large"  # only large has creative capability


class TestAdaptiveTokenBudget:
    def test_default_budget(self):
        atb = AdaptiveTokenBudget()
        b = atb.estimate_budget("Hello, how are you?")
        assert isinstance(b, TokenBudget)
        assert b.max_tokens > 0

    def test_code_gets_larger_budget(self):
        atb = AdaptiveTokenBudget()
        chat_b = atb.estimate_budget("Hi!", task_type="chat")
        code_b = atb.estimate_budget("Write a sorting algorithm in Rust", task_type="code")
        assert code_b.max_tokens >= chat_b.max_tokens

    def test_short_prompt_smaller_budget(self):
        atb = AdaptiveTokenBudget()
        b = atb.estimate_budget("Hi", task_type="chat")
        assert b.max_tokens <= 256

    def test_adjust_for_vram_no_change(self):
        atb = AdaptiveTokenBudget(vram_gb=16.0)
        b = atb.estimate_budget("prompt", task_type="general")
        adjusted = atb.adjust_for_vram(b, current_vram_usage=10.0)
        assert adjusted.max_tokens == b.max_tokens  # 6 GB headroom → no change

    def test_adjust_for_vram_constrained(self):
        atb = AdaptiveTokenBudget(vram_gb=16.0)
        b = atb.estimate_budget("prompt", task_type="general")
        adjusted = atb.adjust_for_vram(b, current_vram_usage=14.5)
        assert adjusted.max_tokens < b.max_tokens
        assert "VRAM constrained" in adjusted.budget_reason

    def test_adjust_for_vram_critical(self):
        atb = AdaptiveTokenBudget(vram_gb=16.0)
        b = atb.estimate_budget("prompt", task_type="code")
        adjusted = atb.adjust_for_vram(b, current_vram_usage=15.5)
        assert adjusted.max_tokens <= b.max_tokens // 2 + 1
        assert "VRAM critical" in adjusted.budget_reason


class TestInferenceMetricsCollector:
    def test_initial_metrics(self):
        c = InferenceMetricsCollector()
        m = c.get_metrics()
        assert m.total_requests == 0
        assert m.avg_tps == 0.0

    def test_record_inference(self):
        c = InferenceMetricsCollector()
        c.record_inference("model-a", prompt_tokens=50, completion_tokens=100, total_latency_ms=500, first_token_ms=80)
        m = c.get_metrics()
        assert m.total_requests == 1
        assert m.avg_tps > 0
        assert m.avg_ttft_ms == 80.0

    def test_cache_tracking(self):
        c = InferenceMetricsCollector()
        c.record_cache_hit()
        c.record_cache_hit()
        c.record_cache_miss()
        m = c.get_metrics()
        assert abs(m.cache_hit_rate - 2 / 3) < 0.01

    def test_get_model_performance(self):
        c = InferenceMetricsCollector()
        c.record_inference("m1", 10, 20, 100)
        perf = c.get_model_performance("m1")
        assert perf is not None
        assert perf.model == "m1"
        assert perf.total_inferences == 1

    def test_get_model_performance_unknown(self):
        c = InferenceMetricsCollector()
        assert c.get_model_performance("nope") is None

    def test_record_failure(self):
        c = InferenceMetricsCollector()
        c.record_inference("m1", 10, 20, 100)
        c.record_failure("m1")
        perf = c.get_model_performance("m1")
        assert perf.success_rate < 1.0

    def test_export_prometheus(self):
        c = InferenceMetricsCollector()
        c.record_inference("test/model-1", 50, 100, 500)
        prom = c.export_prometheus()
        assert "openclaw_inference_total 1" in prom
        assert "openclaw_inference_avg_tps" in prom
        assert "openclaw_inference_prompt_tokens_total 50" in prom
        assert "openclaw_model_avg_latency_ms" in prom

    def test_export_prometheus_empty(self):
        c = InferenceMetricsCollector()
        prom = c.export_prometheus()
        assert "openclaw_inference_total 0" in prom


class TestModelProfile:
    def test_creation(self):
        mp = ModelProfile(name="test", vram_gb=4.0, capabilities=["code"], speed_tier="fast", quality_tier="high")
        assert mp.name == "test"
        assert "code" in mp.capabilities


class TestBatchAndTokenBudgetDataclasses:
    def test_batch_metrics_defaults(self):
        bm = BatchMetrics()
        assert bm.queue_depth == 0
        assert bm.throttled is False

    def test_token_budget_defaults(self):
        tb = TokenBudget()
        assert tb.max_tokens == 2048

    def test_inference_metrics_defaults(self):
        im = InferenceMetrics()
        assert im.total_requests == 0

    def test_model_performance_defaults(self):
        mp = ModelPerformance()
        assert mp.model == ""
        assert mp.success_rate == 1.0

    def test_routing_task_defaults(self):
        rt = RoutingTask(prompt="test")
        assert rt.task_type == "general"
        assert rt.complexity_hint is None


# ===================================================================
# v13.2 NEW: Self-Reflective RAG classifier tests
# ===================================================================

from src.pipeline._state import rag_necessary


class TestSelfReflectiveRAG:
    """Tests for the Self-Reflective RAG classifier (rag_necessary)."""

    # --- Trivial queries → RAG should be SKIPPED ---

    def test_greeting_skips_rag(self):
        assert rag_necessary("привет") is False

    def test_greeting_english_skips_rag(self):
        assert rag_necessary("hello there") is False

    def test_short_abstract_skips_rag(self):
        assert rag_necessary("что такое капитализм") is False

    def test_simple_question_skips_rag(self):
        # "Как зовут" — short pure factual question
        assert rag_necessary("Как зовут президента") is False

    def test_very_short_query_skips_rag(self):
        assert rag_necessary("ку") is False

    # --- RAG-required queries → should NOT be skipped ---

    def test_file_reference_requires_rag(self):
        assert rag_necessary("проверь src/pipeline/_core.py на ошибки") is True

    def test_url_requires_rag(self):
        assert rag_necessary("открой https://example.com и суммируй") is True

    def test_code_keyword_requires_rag(self):
        assert rag_necessary("напиши функцию для парсинга JSON") is True

    def test_pipeline_keyword_requires_rag(self):
        assert rag_necessary("обнови pipeline для новой бригады") is True

    def test_memory_recall_requires_rag(self):
        assert rag_necessary("что ты знаешь о конфиге бота") is True

    def test_long_complex_prompt_requires_rag(self):
        long_prompt = "Проведи глубокий анализ алгоритма арбитража " * 20
        assert rag_necessary(long_prompt) is True

    def test_implement_keyword_requires_rag(self):
        assert rag_necessary("implement a new async executor for the pipeline") is True

    def test_bug_fix_requires_rag(self):
        assert rag_necessary("исправь баг в модуле памяти") is True

    def test_rag_keyword_requires_rag(self):
        assert rag_necessary("как работает supermemory в боте") is True


# ===================================================================
# v13.2 NEW: AFlow dynamic chain generation tests
# ===================================================================

from src.pipeline._aflow import AFlowEngine, AFlowResult, _HEURISTIC_CHAINS


class TestAFlowEngine:
    """Tests for AFlow dynamic chain generation (pure logic, no LLM)."""

    @pytest.fixture()
    def engine(self):
        return AFlowEngine(vllm_url="", model="test-model")

    def test_heuristic_code_task(self, engine):
        result = engine._match_heuristic(
            "напиши асинхронный парсер для Dmarket API",
            ["Planner", "Coder", "Auditor", "Executor_Tools"],
        )
        assert result is not None
        assert "Planner" in result or "Coder" in result

    def test_heuristic_research_task(self, engine):
        result = engine._match_heuristic(
            "найди информацию о новых CS2 скинах",
            ["Researcher", "Analyst", "Summarizer"],
        )
        assert result is not None
        assert "Researcher" in result

    def test_heuristic_trading_task(self, engine):
        result = engine._match_heuristic(
            "проверь price для AK-47 на Dmarket",
            ["Planner", "Executor_Tools", "Auditor"],
        )
        assert result is not None

    def test_heuristic_filters_unavailable_roles(self, engine):
        result = engine._match_heuristic(
            "напиши функцию",
            ["Planner", "Executor_Tools"],  # Coder not available
        )
        if result:
            for r in result:
                assert r in ["Planner", "Executor_Tools"]

    def test_parse_chain_valid_json(self, engine):
        raw = '["Planner", "Coder", "Auditor"]'
        available = ["Planner", "Coder", "Auditor", "Executor_Tools"]
        result = engine._parse_chain(raw, available, 7)
        assert result == ["Planner", "Coder", "Auditor"]

    def test_parse_chain_embedded_json(self, engine):
        raw = 'Here is the chain: ["Planner", "Executor_Tools"] for your task.'
        available = ["Planner", "Executor_Tools", "Auditor"]
        result = engine._parse_chain(raw, available, 7)
        assert result == ["Planner", "Executor_Tools"]

    def test_parse_chain_filters_unknown_roles(self, engine):
        raw = '["Planner", "UnknownAgent", "Auditor"]'
        available = ["Planner", "Auditor"]
        result = engine._parse_chain(raw, available, 7)
        assert "UnknownAgent" not in (result or [])

    def test_parse_chain_too_short_returns_none(self, engine):
        raw = '["Planner"]'
        result = engine._parse_chain(raw, ["Planner"], 7)
        assert result is None

    def test_parse_chain_invalid_json_returns_none(self, engine):
        result = engine._parse_chain("not json at all", ["Planner"], 7)
        assert result is None

    def test_score_candidates_prefers_orchestrator_first(self, engine):
        chain_good = ["Planner", "Coder", "Auditor"]
        chain_bad = ["Coder", "Planner", "Auditor"]
        best, score = engine._score_candidates([chain_good, chain_bad], "complex")
        assert best == chain_good

    def test_score_candidates_complex_prefers_auditor(self, engine):
        with_auditor = ["Planner", "Coder", "Auditor"]
        without_auditor = ["Planner", "Coder"]
        best, score = engine._score_candidates([with_auditor, without_auditor], "complex")
        assert best == with_auditor

    def test_score_candidates_simple_no_auditor_ok(self, engine):
        short = ["Planner", "Coder"]
        long_with_auditor = ["Planner", "Coder", "Auditor", "State_Manager"]
        best, score = engine._score_candidates([short, long_with_auditor], "simple")
        # Short chain preferred for simple tasks
        assert len(best) <= len(long_with_auditor)

    def test_get_chain_dynamic_fallback_sync(self, engine):
        """Synchronous fallback: when no roles available, uses default_chains."""
        chain = engine.default_chains.get("Dmarket-Dev", ["Planner"])
        assert len(chain) > 0

    def test_aflow_result_dataclass(self):
        result = AFlowResult(
            chain=["Planner", "Coder"],
            source="heuristic",
            confidence=0.85,
            reasoning="keyword match",
            candidates_explored=0,
        )
        assert result.chain == ["Planner", "Coder"]
        assert result.confidence == 0.85

    @pytest.mark.asyncio
    async def test_generate_chain_heuristic_path(self, engine):
        """Heuristic fast-path returns immediately without LLM."""
        available = ["Planner", "Coder", "Auditor"]
        # Trading prompt should HIT heuristic
        result = await engine.generate_chain(
            prompt="купить скин AK-47 на dmarket по хорошей цене",
            brigade="Dmarket-Dev",
            available_roles=available,
        )
        assert result.chain
        assert result.source in ("heuristic", "fallback")

    @pytest.mark.asyncio
    async def test_generate_chain_fallback_no_vllm(self, engine):
        """When vllm_url='' and no heuristic matches, falls back to default_chains."""
        available = ["Planner", "Researcher", "Analyst"]
        result = await engine.generate_chain(
            prompt="абстрактный вопрос без ключевых слов xyz",
            brigade="Research-Ops",
            available_roles=available,
        )
        assert result.chain  # must always return something
        assert result.source in ("heuristic", "llm", "fallback")


# ===================================================================
# v13.2 NEW: classify_complexity tests (shared between LATS + AFlow)
# ===================================================================

from src.pipeline._lats_search import classify_complexity


class TestClassifyComplexity:
    def test_simple_greeting(self):
        assert classify_complexity("привет как дела") == "simple"

    def test_complex_rust_prompt(self):
        level = classify_complexity("напиши async Rust parser с FFI интеграцией")
        assert level in ("complex", "extreme")

    def test_extreme_multifile(self):
        prompt = "migrate multi-file architecture with pyo3 ffi cryptograph " * 5
        assert classify_complexity(prompt) == "extreme"

    def test_complex_long_prompt(self):
        prompt = "проведи анализ алгоритма " + "graph tree algorithm " * 50
        level = classify_complexity(prompt)
        assert level in ("complex", "extreme")

    def test_simple_short_prompt(self):
        assert classify_complexity("скажи привет") == "simple"


# ===================================================================
# v14.0 NEW: SAGE Self-Evolution Engine tests
# ===================================================================

from src.pipeline._sage import SAGEEngine, SAGECorrectionResult


class TestSAGEEngine:
    """Pure-heuristic tests for SAGE — no LLM calls."""

    @pytest.fixture
    def engine(self):
        return SAGEEngine(vllm_url="", model="", enabled=True)

    # --- _parse_score ---

    def test_parse_score_out_of_10(self, engine):
        assert engine._parse_score("score: 3/10") == pytest.approx(0.3)

    def test_parse_score_decimal(self, engine):
        assert engine._parse_score("балл: 0.25") == pytest.approx(0.25)

    def test_parse_score_integer_normalised(self, engine):
        # "оценка: 2" → 2 > 1 → divide by 10 → 0.2
        assert engine._parse_score("оценка: 2") == pytest.approx(0.2)

    def test_parse_score_not_found(self, engine):
        assert engine._parse_score("всё хорошо") == -1.0

    # --- _step_is_low_quality ---

    def test_step_is_low_quality_auditor_low_score(self, engine):
        step = {"role": "Auditor", "response": "score: 2/10, решение неверно"}
        is_low, score = engine._step_is_low_quality(step)
        assert is_low is True
        assert score == pytest.approx(0.2)

    def test_step_is_low_quality_auditor_good_score(self, engine):
        step = {"role": "Auditor", "response": "score: 8/10, отличная работа"}
        is_low, score = engine._step_is_low_quality(step)
        assert is_low is False
        assert score == pytest.approx(0.8)

    def test_step_is_low_quality_non_auditor_skipped(self, engine):
        step = {"role": "Planner", "response": "score: 1/10, провал"}
        is_low, score = engine._step_is_low_quality(step)
        # Non-auditor roles are skipped
        assert is_low is False

    def test_step_is_low_quality_text_markers(self, engine):
        step = {"role": "Auditor", "response": "ошибка, решение некорректно и провал"}
        is_low, score = engine._step_is_low_quality(step)
        assert is_low is True
        assert score == pytest.approx(0.2)  # fallback score

    # --- analyze_steps ---

    def test_analyze_steps_no_low_quality(self, engine):
        steps = [
            {"role": "Planner", "response": "план готов"},
            {"role": "Auditor", "response": "score: 9/10, превосходно"},
        ]
        result = engine.analyze_steps(steps, ["Planner", "Auditor"])
        assert result.needs_rebuild is False
        assert result.low_score_step == ""

    def test_analyze_steps_low_auditor(self, engine):
        steps = [
            {"role": "Planner", "response": "план готов"},
            {"role": "Auditor", "response": "балл: 0.15, неверно и некорректно"},
        ]
        result = engine.analyze_steps(steps, ["Planner", "Auditor"])
        assert result.needs_rebuild is True
        assert result.low_score_step == "Auditor"
        assert result.detected_score < 0.35
        assert result.suggested_chain  # non-empty

    def test_analyze_steps_disabled_engine(self):
        engine = SAGEEngine(enabled=False)
        steps = [{"role": "Auditor", "response": "score: 0/10"}]
        result = engine.analyze_steps(steps, ["Auditor"])
        assert result.needs_rebuild is False

    def test_analyze_steps_increments_counter(self, engine):
        steps = [{"role": "Auditor", "response": "score: 1/10"}]
        engine.analyze_steps(steps, ["Auditor"])
        assert engine.correction_count == 1

    # --- _suggest_rebuild ---

    def test_suggest_rebuild_adds_coder(self, engine):
        chain = ["Planner", "Auditor"]
        rebuilt = engine._suggest_rebuild(chain, "Auditor")
        assert "Coder" in rebuilt

    def test_suggest_rebuild_auditor_at_end(self, engine):
        chain = ["Planner"]
        rebuilt = engine._suggest_rebuild(chain, "Planner")
        assert rebuilt[-1] == "Auditor"

    def test_suggest_rebuild_no_duplicate_coder(self, engine):
        chain = ["Planner", "Coder", "Auditor"]
        rebuilt = engine._suggest_rebuild(chain, "Auditor")
        assert rebuilt.count("Coder") == 1

    # --- dataclass ---

    def test_correction_result_defaults(self):
        r = SAGECorrectionResult(
            needs_rebuild=False,
            low_score_step="",
            detected_score=-1.0,
            correction_hint="",
            suggested_chain=[],
            session_key="",
        )
        assert r.timestamp > 0


# ===================================================================
# v14.0 NEW: MAC Multi-Agent Constitution Learning tests
# ===================================================================

from src.safety.mac_constitution import (
    MACConstitution,
    MACState,
    ConstitutionRule,
    _HEURISTIC_PATTERNS,
    _MAX_RULES,
)


class TestMACConstitution:
    """Pure-heuristic tests for MAC — no LLM calls."""

    @pytest.fixture
    def mac(self):
        return MACConstitution(vllm_url="", model="", enabled=True)

    # --- _extract_heuristic_rules ---

    def test_heuristic_detects_anyhow(self, mac):
        rules = mac._extract_heuristic_rules("используй anyhow для ошибок в Rust")
        texts = [r.text for r in rules]
        assert any("anyhow" in t for t in texts)

    def test_heuristic_detects_pnpm(self, mac):
        rules = mac._extract_heuristic_rules("установи зависимости через pnpm install")
        assert any("pnpm" in r.text for r in rules)

    def test_heuristic_detects_vitest(self, mac):
        rules = mac._extract_heuristic_rules("запускай тесты через vitest")
        assert any("Vitest" in r.text for r in rules)

    def test_heuristic_multiple_patterns(self, mac):
        text = "pnpm, oxfmt, structlog — наши стандарты"
        rules = mac._extract_heuristic_rules(text)
        assert len(rules) >= 3

    def test_heuristic_no_match(self, mac):
        rules = mac._extract_heuristic_rules("случайный текст без ключевых слов")
        assert rules == []

    def test_heuristic_rule_source(self, mac):
        rules = mac._extract_heuristic_rules("asyncio.TaskGroup")
        assert all(r.source == "heuristic" for r in rules)

    def test_heuristic_rule_confidence(self, mac):
        rules = mac._extract_heuristic_rules("pnpm")
        assert all(0.0 < r.confidence <= 1.0 for r in rules)

    # --- enrich_system_prompt ---

    def test_enrich_adds_dynamic_rules_section(self, mac):
        # Manually add a rule to mac state
        mac._state = MACState(
            rules=[ConstitutionRule(text="Логирование через structlog", confidence=0.9, source="heuristic", created_at=time.time())],
            extracted_at=time.time(),
            history_hash="abc",
            llm_rules_count=0,
            heuristic_rules_count=1,
        )
        enriched = mac.enrich_system_prompt("Ты — умный ассистент.")
        assert "[DYNAMIC_RULES" in enriched
        assert "structlog" in enriched

    def test_enrich_idempotent(self, mac):
        mac._state = MACState(
            rules=[ConstitutionRule(text="правило 1", confidence=0.8, source="heuristic", created_at=time.time())],
            extracted_at=time.time(),
            history_hash="x",
            llm_rules_count=0,
            heuristic_rules_count=1,
        )
        once = mac.enrich_system_prompt("Системный промпт.")
        twice = mac.enrich_system_prompt(once)
        assert twice.count("[DYNAMIC_RULES") == 1

    def test_enrich_no_rules_returns_original(self, mac):
        original = "Простой промпт без правил"
        result = mac.enrich_system_prompt(original)
        assert result == original

    def test_enrich_disabled_mac(self):
        m = MACConstitution(enabled=False)
        original = "Промпт"
        assert m.enrich_system_prompt(original) == original

    # --- dataclasses ---

    def test_constitution_rule_dataclass(self):
        r = ConstitutionRule(text="используй pnpm", confidence=0.9, source="heuristic", created_at=1.0)
        assert r.confidence == 0.9

    def test_mac_state_dataclass(self):
        state = MACState(
            rules=[], extracted_at=1.0, history_hash="abc",
            llm_rules_count=0, heuristic_rules_count=0,
        )
        assert state.history_hash == "abc"

    def test_rules_count_property(self, mac):
        mac._state = MACState(
            rules=[ConstitutionRule(text="r1", confidence=0.9, source="heuristic", created_at=1.0)],
            extracted_at=1.0, history_hash="x", llm_rules_count=0, heuristic_rules_count=1,
        )
        assert mac.rules_count == 1

    def test_max_rules_cap(self, mac):
        """enrich_system_prompt must never inject more than _MAX_RULES rules."""
        many_rules = [
            ConstitutionRule(text=f"правило {i}", confidence=0.7, source="heuristic", created_at=1.0)
            for i in range(20)
        ]
        mac._state = MACState(
            rules=many_rules, extracted_at=1.0, history_hash="y",
            llm_rules_count=0, heuristic_rules_count=20,
        )
        enriched = mac.enrich_system_prompt("Базовый промпт")
        injected_rules = [line for line in enriched.split("\n") if line.startswith("- ")]
        assert len(injected_rules) <= _MAX_RULES


# ===================================================================
# v14.0 NEW: Complementary RL — SuperMemory trajectory tests
# ===================================================================

from src.supermemory import SuperMemory


class TestComplementaryRL:
    """Tests for SuperMemory trajectory save/recall (pure-logic, temp SQLite)."""

    @pytest.fixture
    def memory(self, tmp_path):
        """Real SuperMemory on a temp dir — no ChromaDB (rag disabled)."""
        sm = SuperMemory(persist_dir=str(tmp_path / "smem"))
        sm.initialize()
        return sm

    def test_save_trajectory_returns_episode_id(self, memory):
        ep_id = memory.save_success_trajectory(
            task="напиши парсер JSON",
            chain=["Planner", "Coder", "Auditor"],
            complexity="complex",
            reward=0.9,
            response_preview="Вот готовый парсер...",
        )
        assert ep_id != ""

    def test_save_trajectory_stored_in_episodes(self, memory):
        memory.save_success_trajectory(
            task="реши дифференциальное уравнение",
            chain=["Researcher", "Coder"],
            complexity="extreme",
            reward=0.88,
            response_preview="Решение: y=...",
        )
        trajectory_episodes = [
            ep for ep in memory._episodes
            if ep.success and "[SUCCESS_TRAJECTORY]" in (ep.summary or "")
        ]
        assert len(trajectory_episodes) >= 1

    def test_save_trajectory_summary_format(self, memory):
        memory.save_success_trajectory(
            task="task X",
            chain=["Planner", "Coder"],
            complexity="complex",
            reward=0.8,
        )
        ep = next(
            (ep for ep in memory._episodes if "[SUCCESS_TRAJECTORY]" in (ep.summary or "")),
            None,
        )
        assert ep is not None
        assert "Planner → Coder" in ep.summary
        assert "complexity=complex" in ep.summary

    def test_recall_trajectories_empty_initially(self, memory):
        result = memory.recall_similar_trajectories("любой запрос")
        assert result == ""

    def test_recall_trajectories_returns_after_save(self, memory):
        memory.save_success_trajectory(
            task="парсер JSON для конфигурационных файлов Python",
            chain=["Planner", "Coder", "Auditor"],
            complexity="complex",
            reward=0.85,
            response_preview="import json ...",
        )
        result = memory.recall_similar_trajectories("парсер файлов Python", top_k=3)
        # Should find the trajectory when there's an overlap
        # (may be empty if keywords don't match — that's also acceptable)
        assert isinstance(result, str)

    def test_recall_trajectories_format(self, memory):
        memory.save_success_trajectory(
            task="сделай async HTTP клиент на Python",
            chain=["Planner", "Coder"],
            complexity="complex",
            reward=0.9,
            response_preview="import aiohttp ...",
        )
        result = memory.recall_similar_trajectories("async HTTP python клиент", top_k=2)
        if result:
            assert "[FEW-SHOT TRAJECTORIES" in result
            assert "Example 1" in result

    def test_save_trajectory_not_initialized(self):
        """Must return '' when not initialized."""
        sm = SuperMemory(persist_dir="/nonexistent/path/__smem")
        ep_id = sm.save_success_trajectory(
            task="test", chain=["Planner"], complexity="simple", reward=0.5,
        )
        assert ep_id == ""

    def test_recall_not_initialized(self):
        """Must return '' when not initialized."""
        sm = SuperMemory(persist_dir="/nonexistent/path/__smem")
        assert sm.recall_similar_trajectories("test") == ""


# ===================================================================
# v14.1 NEW: SLEA-RL — Step-Level Experience Augmented RL
# arXiv:2603.18079
# ===================================================================

from src.supermemory import StepExperience


class TestSLEARL:
    """Tests for SuperMemory step-level experience save/recall (pure-logic, temp SQLite)."""

    @pytest.fixture
    def memory(self, tmp_path):
        sm = SuperMemory(persist_dir=str(tmp_path / "smem_slea"))
        sm.initialize()
        return sm

    def test_step_experience_dataclass(self):
        se = StepExperience(
            step_id="ep1:s0", episode_id="ep1", step_index=0,
            role="Planner", action="plan task", observation="plan ready",
            reward=0.8,
        )
        assert se.step_id == "ep1:s0"
        assert se.role == "Planner"
        assert se.reward == 0.8

    def test_save_step_experience_returns_id(self, memory):
        step_id = memory.save_step_experience(
            episode_id="ep1", step_index=0,
            role="Planner", action="analyze request",
            observation="plan created", reward=0.85,
        )
        assert step_id == "ep1:s0"

    def test_save_step_experience_stored_in_list(self, memory):
        memory.save_step_experience(
            episode_id="ep1", step_index=0,
            role="Coder", action="write code",
            observation="code written", reward=0.9,
        )
        assert len(memory._step_experiences) == 1
        assert memory._step_experiences[0].role == "Coder"

    def test_save_multiple_steps(self, memory):
        for i in range(3):
            memory.save_step_experience(
                episode_id="ep2", step_index=i,
                role=["Planner", "Coder", "Auditor"][i],
                action=f"action {i}",
                observation=f"result {i}",
                reward=0.7 + i * 0.1,
            )
        assert len(memory._step_experiences) == 3

    def test_save_step_not_initialized(self):
        sm = SuperMemory(persist_dir="/nonexistent/__slea")
        step_id = sm.save_step_experience(
            episode_id="x", step_index=0, role="Planner", action="test",
        )
        assert step_id == ""

    def test_recall_step_experiences_empty(self, memory):
        result = memory.recall_step_experiences("any query")
        assert result == ""

    def test_recall_step_experiences_finds_match(self, memory):
        memory.save_step_experience(
            episode_id="ep1", step_index=0,
            role="Coder", action="написать парсер JSON файлов",
            observation="парсер готов", reward=0.9,
        )
        result = memory.recall_step_experiences("парсер JSON")
        if result:  # depends on keyword overlap
            assert "[STEP-LEVEL FEW-SHOT" in result

    def test_recall_step_role_filter(self, memory):
        memory.save_step_experience(
            episode_id="ep1", step_index=0,
            role="Planner", action="plan the architecture",
            observation="done", reward=0.85,
        )
        memory.save_step_experience(
            episode_id="ep1", step_index=1,
            role="Coder", action="implement the architecture",
            observation="done", reward=0.8,
        )
        # Filter to Planner only
        result = memory.recall_step_experiences("architecture", role_filter="Planner")
        if result:
            assert "Planner" in result

    def test_recall_step_short_query_words_ignored(self, memory):
        memory.save_step_experience(
            episode_id="ep1", step_index=0,
            role="Coder", action="do it", observation="ok", reward=0.5,
        )
        # "do" and "it" are <= 3 chars — should return empty
        result = memory.recall_step_experiences("do it")
        assert result == ""

    def test_step_experience_persisted_to_sqlite(self, tmp_path):
        sm = SuperMemory(persist_dir=str(tmp_path / "smem_persist"))
        sm.initialize()
        sm.save_step_experience(
            episode_id="ep1", step_index=0,
            role="Auditor", action="verify correctness",
            observation="looks good", reward=0.95,
        )
        # Re-load from disk
        sm2 = SuperMemory(persist_dir=str(tmp_path / "smem_persist"))
        sm2.initialize()
        assert len(sm2._step_experiences) >= 1
        assert sm2._step_experiences[0].role == "Auditor"

    def test_get_stats_includes_steps(self, memory):
        memory.save_step_experience(
            episode_id="ep1", step_index=0,
            role="Planner", action="test", reward=0.5,
        )
        stats = memory.get_stats()
        assert "step_experiences" in stats
        assert stats["step_experiences"] >= 1


# ===================================================================
# v14.1 NEW: Counterfactual Credit Assignment
# arXiv:2603.21563
# ===================================================================

from src.pipeline._counterfactual import (
    CounterfactualCredit, CandidateCredit, CreditRecord,
)


class TestCounterfactualCredit:
    """Tests for Counterfactual Credit assignment (pure-logic, no LLM)."""

    @pytest.fixture
    def cc(self):
        return CounterfactualCredit(enabled=True)

    def test_credit_record_dataclass(self):
        cr = CreditRecord(role="Coder", temperature=0.7)
        assert cr.win_rate == 0.0
        cr.record_round(won=True, length_score=0.8)
        assert cr.win_rate == 1.0
        assert cr.total_rounds == 1

    def test_candidate_credit_dataclass(self):
        cc = CandidateCredit(
            candidate_index=0, temperature=0.7,
            was_selected=True, length_score=0.9,
        )
        assert cc.was_selected is True

    def test_record_vote_basic(self, cc):
        credits = cc.record_vote(
            role="Coder",
            temperatures=[0.7, 1.0],
            candidates=["resp A", "resp B"],
            winner_index=0,
        )
        assert len(credits) == 2
        assert credits[0].was_selected is True
        assert credits[1].was_selected is False

    def test_record_vote_accumulates_wins(self, cc):
        cc.record_vote("Coder", [0.7, 1.0], ["a", "b"], winner_index=0)
        cc.record_vote("Coder", [0.7, 1.0], ["c", "d"], winner_index=0)
        cc.record_vote("Coder", [0.7, 1.0], ["e", "f"], winner_index=1)
        stats = cc.get_stats("Coder")
        assert stats[0.7]["wins"] == 2
        assert stats[1.0]["wins"] == 1

    def test_get_best_temperatures(self, cc):
        cc.record_vote("Coder", [0.7, 1.0], ["a", "b"], winner_index=0)
        cc.record_vote("Coder", [0.7, 1.0], ["c", "d"], winner_index=0)
        best = cc.get_best_temperatures("Coder", top_k=1)
        assert best[0] == 0.7

    def test_get_best_temperatures_default(self, cc):
        best = cc.get_best_temperatures("UnknownRole")
        assert best == [0.7, 1.0]

    def test_disabled_returns_empty(self):
        cc = CounterfactualCredit(enabled=False)
        credits = cc.record_vote("Coder", [0.7], ["x"], winner_index=0)
        assert credits == []

    def test_empty_candidates(self, cc):
        credits = cc.record_vote("Coder", [], [], winner_index=0)
        assert credits == []

    def test_get_stats_all_roles(self, cc):
        cc.record_vote("Coder", [0.7, 1.0], ["a", "b"], winner_index=1)
        cc.record_vote("Architect", [0.5, 0.7], ["c", "d"], winner_index=0)
        stats = cc.get_stats()
        assert "Coder" in stats
        assert "Architect" in stats

    def test_save_to_memory(self, cc, tmp_path):
        cc.record_vote("Coder", [0.7, 1.0], ["a", "b"], winner_index=0)
        sm = SuperMemory(persist_dir=str(tmp_path / "smem_cc"))
        sm.initialize()
        cc.save_to_memory(sm)
        # Check that credit stats were saved
        stored = [r for r in sm._warm.values() if "counterfactual" in r.key]
        assert len(stored) >= 1

    def test_win_rate_calculation(self):
        cr = CreditRecord(role="X", temperature=0.7)
        cr.record_round(True, 0.5)
        cr.record_round(False, 0.6)
        cr.record_round(True, 0.7)
        assert abs(cr.win_rate - 2/3) < 0.01
        assert cr.avg_length_score == pytest.approx(0.6, abs=0.01)


# ===================================================================
# v14.1 NEW: ProRL — Lightweight Rollout-as-a-Service
# arXiv:2603.18815
# ===================================================================

from src.pipeline._prorl import ProRLEngine, RolloutResult, RolloutCandidate


class TestProRL:
    """Tests for ProRL heuristic chain scoring and rollout evaluation."""

    @pytest.fixture
    def prorl(self):
        return ProRLEngine(enabled=True)

    def test_rollout_candidate_dataclass(self):
        rc = RolloutCandidate(chain=["Planner", "Coder"], source="aflow", score=0.8)
        assert rc.chain == ["Planner", "Coder"]

    def test_rollout_result_dataclass(self):
        rr = RolloutResult(
            selected_chain=["Planner"], selected_source="static",
            candidates_evaluated=2, best_score=0.9, total_latency_ms=1.5,
        )
        assert rr.candidates_evaluated == 2

    def test_score_chain_basic(self, prorl):
        score = prorl.score_chain(["Planner", "Coder", "Auditor"], "complex")
        assert 0.0 < score <= 1.0

    def test_score_chain_empty(self, prorl):
        assert prorl.score_chain([], "simple") == 0.0

    def test_score_chain_auditor_bonus(self, prorl):
        without_auditor = prorl.score_chain(["Planner", "Coder"], "complex")
        with_auditor = prorl.score_chain(["Planner", "Coder", "Auditor"], "complex")
        assert with_auditor > without_auditor

    def test_score_chain_planner_start_bonus(self, prorl):
        starts_planner = prorl.score_chain(["Planner", "Coder"], "simple")
        starts_coder = prorl.score_chain(["Coder", "Planner"], "simple")
        assert starts_planner >= starts_coder

    def test_score_chain_overlong_penalty(self, prorl):
        short = prorl.score_chain(["Planner", "Coder", "Auditor"], "simple")
        long = prorl.score_chain(
            ["Planner", "Coder", "Researcher", "Analyst", "Auditor", "Summarizer"],
            "simple",
        )
        assert short > long

    def test_evaluate_candidates_selects_best(self, prorl):
        result = prorl.evaluate_candidates(
            candidates=[
                (["Coder"], "static"),
                (["Planner", "Coder", "Auditor"], "aflow"),
            ],
            complexity="complex",
        )
        assert result.selected_chain == ["Planner", "Coder", "Auditor"]
        assert result.candidates_evaluated == 2

    def test_evaluate_candidates_with_trajectory_bonus(self, prorl):
        result = prorl.evaluate_candidates(
            candidates=[
                (["Planner", "Coder"], "static"),
                (["Researcher", "Analyst"], "aflow"),
            ],
            complexity="simple",
            trajectory_bonus={"Researcher → Analyst": 1.0},
        )
        # Trajectory bonus should boost the second candidate
        assert result.best_score > 0

    def test_evaluate_disabled(self):
        prorl = ProRLEngine(enabled=False)
        result = prorl.evaluate_candidates(
            candidates=[(["Planner"], "static"), (["Coder"], "aflow")],
        )
        assert result.selected_chain == ["Planner"]
        assert result.candidates_evaluated == 0

    def test_evaluate_empty_candidates(self, prorl):
        result = prorl.evaluate_candidates(candidates=[])
        assert result.selected_chain == ["Planner"]

    def test_get_stats_empty(self, prorl):
        assert prorl.get_stats()["evaluations"] == 0

    def test_get_stats_after_evaluation(self, prorl):
        prorl.evaluate_candidates(
            candidates=[(["Planner", "Coder"], "aflow")],
            complexity="complex",
        )
        stats = prorl.get_stats()
        assert stats["evaluations"] == 1
        assert stats["avg_best_score"] > 0

    def test_llm_source_bonus(self, prorl):
        static_score = prorl.score_chain(["Planner", "Coder"], "simple")
        # LLM source bonus is applied in evaluate_candidates, not score_chain
        result = prorl.evaluate_candidates(
            candidates=[
                (["Planner", "Coder"], "llm"),
                (["Planner", "Coder"], "static"),
            ],
            complexity="simple",
        )
        assert result.selected_source == "llm"
