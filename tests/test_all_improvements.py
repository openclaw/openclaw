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
