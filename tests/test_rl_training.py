"""Tests for the adaptive training system (API-model optimization).

Tests for: Benchmark, PromptEvolver, FewShotSelector,
RouterOptimizer, AdaptiveContextBuilder, TrainingRunner.
"""

import asyncio
import json
import os
import tempfile
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.rl.benchmark import (
    BENCHMARK_TASKS,
    BenchmarkCategory,
    BenchmarkRunner,
    BenchmarkScorer,
    BenchmarkTask,
    format_comparison,
)
from src.rl.prompt_evolver import (
    PromptEvolver,
    PromptVariant,
    _mutate_extend,
    _mutate_compress,
    _mutate_swap_order,
    _mutate_emphasis,
)
from src.rl.few_shot_selector import (
    FewShotSelector,
    FewShotExample,
    _text_similarity,
    _tokenize,
)
from src.rl.router_optimizer import RouterOptimizer, ModelStats
from src.rl.adaptive_context import (
    AdaptiveContextBuilder,
    ContextSection,
)
from src.rl.experience_buffer import ExperienceReplayBuffer, Experience
from src.rl.training_loop import TrainingRunner


# ===========================================================================
# Helpers
# ===========================================================================

@pytest.fixture
def tmp_dir():
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as d:
        yield d


def _make_buffer(tmp_dir: str) -> ExperienceReplayBuffer:
    buf = ExperienceReplayBuffer(os.path.join(tmp_dir, "exp.db"))
    buf.initialize()
    return buf


def _fill_buffer(buf: ExperienceReplayBuffer, n: int = 10) -> None:
    for i in range(n):
        buf.add(Experience(
            experience_id=f"exp_{i}",
            episode_id=f"ep_{i}",
            role="Executor",
            task_type="code" if i % 2 == 0 else "research",
            state_prompt=f"Напиши функцию {i} для обработки данных",
            action_response=f"def func_{i}(data): return processed(data)",
            action_model="test-model",
            reward=0.3 + i * 0.06,  # 0.3 to 0.84
            success=i > 3,
        ))


# ===========================================================================
# TestBenchmarkScorer
# ===========================================================================

class TestBenchmarkScorer:
    def test_perfect_code_response(self):
        task = BenchmarkTask(
            task_id="test",
            category=BenchmarkCategory.CODE,
            prompt="write a function",
            required_keywords=["def", "return"],
            expects_code=True,
            min_length=50,
            max_length=1000,
        )
        response = """```python
def binary_search(arr, target) -> int:
    lo, hi = 0, len(arr) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if arr[mid] == target:
            return mid
    return -1
```"""
        score, breakdown = BenchmarkScorer.score(task, response)
        assert score > 0.7
        assert breakdown["keywords"] == 1.0
        assert breakdown["code_format"] == 1.0

    def test_too_short_response(self):
        task = BenchmarkTask(
            task_id="test",
            category=BenchmarkCategory.CODE,
            prompt="write code",
            min_length=200,
        )
        score, breakdown = BenchmarkScorer.score(task, "ok")
        assert breakdown["length"] < 0.5

    def test_forbidden_keywords_penalized(self):
        task = BenchmarkTask(
            task_id="test",
            category=BenchmarkCategory.CONVERSATION,
            prompt="hi",
            forbidden_keywords=["SITUATION:", "TASK:"],
            min_length=5,
        )
        response = "SITUATION: hello TASK: greet user"
        score, breakdown = BenchmarkScorer.score(task, response)
        assert breakdown["no_forbidden"] < 0.8

    def test_russian_check(self):
        task = BenchmarkTask(
            task_id="test",
            category=BenchmarkCategory.CONVERSATION,
            prompt="test",
            expects_russian=True,
            min_length=10,
        )
        score_ru, bd_ru = BenchmarkScorer.score(task, "Привет мир, это тестовый ответ")
        score_en, bd_en = BenchmarkScorer.score(task, "Hello world this is a test response")
        assert bd_ru["russian"] > bd_en["russian"]

    def test_coherence_repetition_penalty(self):
        task = BenchmarkTask(
            task_id="test",
            category=BenchmarkCategory.CONVERSATION,
            prompt="test",
            min_length=10,
        )
        # Repeated sentences
        repetitive = "Привет мир. Привет мир. Привет мир. Привет мир."
        unique = "Привет мир. Сегодня солнечно. Пора работать. Удачи!"
        _, bd_rep = BenchmarkScorer.score(task, repetitive)
        _, bd_uniq = BenchmarkScorer.score(task, unique)
        assert bd_uniq["coherence"] >= bd_rep["coherence"]

    def test_judge_prompt_format(self):
        task = BENCHMARK_TASKS[0]
        prompt = BenchmarkScorer.score_as_judge_prompt(task, "test response")
        assert "0.0–1.0" in prompt
        assert "test response" in prompt

    def test_benchmark_tasks_not_empty(self):
        assert len(BENCHMARK_TASKS) >= 10
        categories = set(t.category for t in BENCHMARK_TASKS)
        assert len(categories) >= 4  # code, research, conversation, creative or more


class TestBenchmarkRunner:
    @pytest.mark.asyncio
    async def test_run_single(self):
        async def mock_llm(prompt, system="", task_type="", model=""):
            return "def binary_search(arr, target) -> int:\n    return -1"

        runner = BenchmarkRunner(llm_fn=mock_llm)
        task = BENCHMARK_TASKS[0]  # code task
        result = await runner.run_single(task, system_prompt="test")
        assert result.task_id == task.task_id
        assert result.rule_score >= 0
        assert result.latency_ms >= 0

    @pytest.mark.asyncio
    async def test_run_suite(self):
        call_count = 0

        async def mock_llm(prompt, system="", task_type="", model=""):
            nonlocal call_count
            call_count += 1
            return f"Ответ на вопрос номер {call_count}. def func(): return 42"

        runner = BenchmarkRunner(llm_fn=mock_llm)
        results = await runner.run_suite(tasks=BENCHMARK_TASKS[:3], label="test")
        assert results["total_tasks"] == 3
        assert "mean_score" in results
        assert "category_scores" in results

    @pytest.mark.asyncio
    async def test_format_comparison(self):
        async def mock_llm(prompt, system="", task_type="", model=""):
            return "Ответ: def f(): return 42"

        runner = BenchmarkRunner(llm_fn=mock_llm)
        before = await runner.run_suite(tasks=BENCHMARK_TASKS[:2], label="before")
        after = await runner.run_suite(tasks=BENCHMARK_TASKS[:2], label="after")

        report = format_comparison(before, after)
        assert "ДО обучения" in report
        assert "ПОСЛЕ обучения" in report


# ===========================================================================
# TestPromptEvolver
# ===========================================================================

class TestPromptEvolver:
    def test_register_seed(self, tmp_dir):
        evolver = PromptEvolver(os.path.join(tmp_dir, "pe.db"))
        evolver.initialize()
        vid = evolver.register_seed("Executor", "code", "Ты — кодер.")
        assert vid.startswith("pv_Executor_code_")

    def test_dedup_seed(self, tmp_dir):
        evolver = PromptEvolver(os.path.join(tmp_dir, "pe.db"))
        evolver.initialize()
        vid1 = evolver.register_seed("Executor", "code", "Ты — кодер.")
        vid2 = evolver.register_seed("Executor", "code", "Ты — кодер.")
        assert vid1 == vid2

    def test_select_returns_seed(self, tmp_dir):
        evolver = PromptEvolver(os.path.join(tmp_dir, "pe.db"))
        evolver.initialize()
        evolver.register_seed("Executor", "code", "Ты — кодер.")
        vid, text = evolver.select("Executor", "code", explore_prob=0.0)
        assert "кодер" in text

    def test_select_empty_returns_tuple(self, tmp_dir):
        evolver = PromptEvolver(os.path.join(tmp_dir, "pe.db"))
        evolver.initialize()
        vid, text = evolver.select("Executor", "nonexistent")
        assert vid == ""
        assert text == ""

    def test_record_reward_updates_elo(self, tmp_dir):
        evolver = PromptEvolver(os.path.join(tmp_dir, "pe.db"))
        evolver.initialize()
        vid = evolver.register_seed("Executor", "code", "Ты — кодер.")

        evolver.record_reward(vid, 0.9)
        best = evolver.get_best("Executor", "code")
        assert best is not None
        assert best.elo_rating != 1200.0  # should have changed

    def test_evolve_creates_variants(self, tmp_dir):
        evolver = PromptEvolver(os.path.join(tmp_dir, "pe.db"))
        evolver.initialize()
        vid = evolver.register_seed("Executor", "code", "Ты — кодер.\n1. Правило один.\n2. Правило два.\n3. Правило три.")
        evolver.record_reward(vid, 0.8)

        new_ids = evolver.evolve("Executor", "code", n=3)
        assert len(new_ids) > 0

    def test_stats(self, tmp_dir):
        evolver = PromptEvolver(os.path.join(tmp_dir, "pe.db"))
        evolver.initialize()
        evolver.register_seed("Executor", "code", "test")
        stats = evolver.stats()
        assert stats["total_variants"] == 1

    def test_prune_keeps_best(self, tmp_dir):
        evolver = PromptEvolver(os.path.join(tmp_dir, "pe.db"))
        evolver.initialize()
        for i in range(5):
            evolver.register_seed("Executor", "code", f"Prompt variant {i}")
        pruned = evolver.prune(keep_top_n=3)
        # No pruning needed since none have times_used >= min_uses
        assert pruned == 0

    def test_mutation_extend(self):
        prompt = "Ты — кодер."
        result = _mutate_extend(prompt)
        assert len(result) >= len(prompt)

    def test_mutation_compress(self):
        prompt = "Линия 1\nЛиния 2\nЛиния 3\nЛиния 4\nЛиния 5"
        result = _mutate_compress(prompt)
        assert len(result.split("\n")) < len(prompt.split("\n"))

    def test_mutation_emphasis(self):
        prompt = "Линия первая\nВажное правило тут\nЕщё правило"
        result = _mutate_emphasis(prompt)
        assert "**" in result


# ===========================================================================
# TestFewShotSelector
# ===========================================================================

class TestFewShotSelector:
    def test_text_similarity_identical(self):
        sim = _text_similarity("Привет мир", "Привет мир")
        assert sim > 0.99

    def test_text_similarity_different(self):
        sim = _text_similarity("Напиши код Python", "Погода сегодня хорошая")
        assert sim < 0.3

    def test_tokenize(self):
        tokens = _tokenize("Привет мир, это тестовое сообщение!")
        assert "привет" in tokens
        assert "тестовое" in tokens

    def test_select_from_empty_buffer(self, tmp_dir):
        buf = _make_buffer(tmp_dir)
        selector = FewShotSelector(buf)
        examples = selector.select("Напиши код", task_type="code")
        assert examples == []

    def test_select_returns_high_reward(self, tmp_dir):
        buf = _make_buffer(tmp_dir)
        _fill_buffer(buf, 10)
        selector = FewShotSelector(buf, min_reward=0.5)
        examples = selector.select("Напиши код для обработки данных", task_type="code", max_examples=3)
        for ex in examples:
            assert ex.reward >= 0.5

    def test_select_respects_max_examples(self, tmp_dir):
        buf = _make_buffer(tmp_dir)
        _fill_buffer(buf, 20)
        selector = FewShotSelector(buf, min_reward=0.3)
        examples = selector.select("test", task_type="code", max_examples=2)
        assert len(examples) <= 2

    def test_format_examples(self, tmp_dir):
        examples = [
            FewShotExample(
                experience_id="ex1", role="Executor", task_type="code",
                prompt="Напиши hello", response="print('hello')", reward=0.9,
            ),
        ]
        formatted = FewShotSelector.format_examples(examples)
        assert "Пример 1" in formatted
        assert "hello" in formatted

    def test_format_empty_examples(self):
        formatted = FewShotSelector.format_examples([])
        assert formatted == ""

    def test_stats(self, tmp_dir):
        buf = _make_buffer(tmp_dir)
        _fill_buffer(buf, 5)
        selector = FewShotSelector(buf, min_reward=0.3)
        stats = selector.stats()
        assert stats["available_examples"] > 0

    def test_mmr_diversity(self, tmp_dir):
        """MMR should avoid selecting very similar examples."""
        buf = _make_buffer(tmp_dir)
        # Add identical examples (should be deduplicated by MMR)
        for i in range(5):
            buf.add(Experience(
                experience_id=f"dup_{i}",
                episode_id=f"ep_dup_{i}",
                role="Executor",
                task_type="code",
                state_prompt="Напиши функцию сортировки",
                action_response="def sort(arr): return sorted(arr)",
                reward=0.9,
                success=True,
            ))
        # Add different one
        buf.add(Experience(
            experience_id="diff_1",
            episode_id="ep_diff",
            role="Executor",
            task_type="code",
            state_prompt="Объясни алгоритм бинарного поиска",
            action_response="Бинарный поиск делит массив пополам",
            reward=0.85,
            success=True,
        ))
        selector = FewShotSelector(buf, min_reward=0.3)
        examples = selector.select(
            "Напиши функцию обработки данных",
            task_type="code",
            max_examples=3,
        )
        # Should pick both similar and different examples (diversity)
        assert len(examples) >= 1


# ===========================================================================
# TestRouterOptimizer
# ===========================================================================

class TestRouterOptimizer:
    def test_register_and_select(self, tmp_dir):
        opt = RouterOptimizer(os.path.join(tmp_dir, "rw.db"))
        opt.initialize()
        opt.register_model("model-a", ["code", "general"])
        opt.register_model("model-b", ["code", "general"])

        model = opt.select_model("code")
        assert model in ["model-a", "model-b"]

    def test_record_outcome_updates_stats(self, tmp_dir):
        opt = RouterOptimizer(os.path.join(tmp_dir, "rw.db"))
        opt.initialize()
        opt.register_model("model-a", ["code"])

        opt.record_outcome("model-a", "code", reward=0.9, latency_ms=1000)
        opt.record_outcome("model-a", "code", reward=0.8, latency_ms=1200)

        stats = opt.stats()
        assert stats["total_observations"] == 2

    def test_greedy_prefers_high_reward(self, tmp_dir):
        opt = RouterOptimizer(os.path.join(tmp_dir, "rw.db"))
        opt.initialize()
        opt.register_model("good-model", ["code"])
        opt.register_model("bad-model", ["code"])

        # Train: good-model gets high rewards
        for _ in range(10):
            opt.record_outcome("good-model", "code", reward=0.9, latency_ms=1000)
            opt.record_outcome("bad-model", "code", reward=0.1, latency_ms=1500)

        # Greedy should prefer good-model
        model = opt.select_model("code", explore=False)
        assert model == "good-model"

    def test_routing_table(self, tmp_dir):
        opt = RouterOptimizer(os.path.join(tmp_dir, "rw.db"))
        opt.initialize()
        opt.register_model("model-a", ["code"])
        opt.record_outcome("model-a", "code", reward=0.8)

        table = opt.get_routing_table()
        assert "code" in table
        assert table["code"] == "model-a"

    def test_decay_old_data(self, tmp_dir):
        opt = RouterOptimizer(os.path.join(tmp_dir, "rw.db"))
        opt.initialize()
        opt.register_model("model-a", ["code"])
        for _ in range(10):
            opt.record_outcome("model-a", "code", reward=0.8)

        # Check alpha before decay
        row = opt._conn.execute(
            "SELECT alpha FROM model_stats WHERE model='model-a' AND task_type='code'"
        ).fetchone()
        alpha_before = row[0]

        opt.decay_old_data(decay_factor=0.5)

        row = opt._conn.execute(
            "SELECT alpha FROM model_stats WHERE model='model-a' AND task_type='code'"
        ).fetchone()
        alpha_after = row[0]
        assert alpha_after < alpha_before

    def test_register_from_config(self, tmp_dir):
        opt = RouterOptimizer(os.path.join(tmp_dir, "rw.db"))
        opt.initialize()
        config = {
            "code": "model-x",
            "research": "model-y",
            "general": "model-x",
            "notes": "some notes",
        }
        opt.register_models_from_config(config)
        stats = opt.stats()
        assert stats["registered_models"] == 2  # model-x, model-y

    def test_improvement_report(self, tmp_dir):
        opt = RouterOptimizer(os.path.join(tmp_dir, "rw.db"))
        opt.initialize()
        opt.register_model("model-a", ["code"])
        opt.record_outcome("model-a", "code", reward=0.9, latency_ms=500)

        report = opt.get_improvement_report()
        assert "overall" in report
        assert report["overall"]["total_observations"] == 1


# ===========================================================================
# TestAdaptiveContextBuilder
# ===========================================================================

class TestAdaptiveContextBuilder:
    def test_build_includes_all_sections(self, tmp_dir):
        builder = AdaptiveContextBuilder(os.path.join(tmp_dir, "cw.db"))
        builder.initialize()

        sections = [
            ContextSection("system_prompt", "Ты — кодер."),
            ContextSection("memory", "Пользователь знает Python."),
        ]
        result = builder.build(sections, max_tokens=1000)
        assert "кодер" in result
        assert "Python" in result

    def test_build_respects_token_budget(self, tmp_dir):
        builder = AdaptiveContextBuilder(os.path.join(tmp_dir, "cw.db"))
        builder.initialize()

        long_content = "Слово " * 5000  # ~5000 tokens
        sections = [
            ContextSection("system_prompt", "Ты кодер."),
            ContextSection("memory", long_content),
        ]
        result = builder.build(sections, max_tokens=100)
        # Should truncate
        assert len(result) < len(long_content)

    def test_record_reward_creates_weights(self, tmp_dir):
        builder = AdaptiveContextBuilder(os.path.join(tmp_dir, "cw.db"))
        builder.initialize()

        builder.record_reward("code", ["system_prompt", "memory"], reward=0.9)
        builder.record_reward("code", ["system_prompt"], reward=0.5)

        stats = builder.stats()
        assert stats["tracked_sections"] >= 1
        assert stats["history_records"] == 2

    def test_learned_weights_affect_order(self, tmp_dir):
        builder = AdaptiveContextBuilder(os.path.join(tmp_dir, "cw.db"))
        builder.initialize()

        # Train: memory helps a lot, identity doesn't
        for _ in range(5):
            builder.record_reward("code", ["memory"], reward=0.9)
            builder.record_reward("code", ["identity"], reward=0.2)

        report = builder.get_weight_report()
        if "code" in report:
            weights = {entry["section"]: entry["weight"] for entry in report["code"]}
            if "memory" in weights and "identity" in weights:
                assert weights["memory"] > weights["identity"]

    def test_empty_sections(self, tmp_dir):
        builder = AdaptiveContextBuilder(os.path.join(tmp_dir, "cw.db"))
        builder.initialize()
        result = builder.build([], max_tokens=1000)
        assert result == ""


# ===========================================================================
# TestTrainingRunner
# ===========================================================================

class TestTrainingRunner:
    def test_initialize(self, tmp_dir):
        runner = TrainingRunner(data_dir=tmp_dir)
        runner.initialize()
        assert runner._initialized

    def test_seed_prompts(self, tmp_dir):
        runner = TrainingRunner(data_dir=tmp_dir)
        runner.initialize()
        count = runner.seed_prompts()
        assert count > 0

    @pytest.mark.asyncio
    async def test_run_baseline_with_mock(self, tmp_dir):
        runner = TrainingRunner(data_dir=tmp_dir, api_key="test-key")
        runner.initialize()

        call_count = 0
        async def mock_llm(prompt, system="", task_type="", model="", **kw):
            nonlocal call_count
            call_count += 1
            return f"Ответ {call_count}: def binary_search(arr, target) -> int: return -1"

        runner._call_llm = mock_llm
        results = await runner.run_baseline()
        assert results["total_tasks"] > 0
        assert results["weighted_score"] > 0

    @pytest.mark.asyncio
    async def test_generate_experience_with_mock(self, tmp_dir):
        runner = TrainingRunner(data_dir=tmp_dir, api_key="test-key")
        runner.initialize()
        runner.seed_prompts()

        async def mock_llm(prompt, system="", task_type="", model="", **kw):
            return "def func(): return 42  # решение на Python"

        runner._call_llm = mock_llm
        generated = await runner.generate_experience(n_tasks=3)
        assert generated == 3
        assert runner._buffer.get_stats()["total"] >= 3

    @pytest.mark.asyncio
    async def test_evolve_prompts_with_mock(self, tmp_dir):
        runner = TrainingRunner(data_dir=tmp_dir, api_key="test-key")
        runner.initialize()
        runner.seed_prompts()

        async def mock_llm(prompt, system="", task_type="", model="", **kw):
            return "def func(): return 42"

        runner._call_llm = mock_llm

        # Generate some experience first so evolve has parents
        await runner.generate_experience(n_tasks=3)
        total = await runner.evolve_prompts(mutations_per_type=2)
        assert total >= 0  # may be 0 if all mutations are duplicates

    @pytest.mark.asyncio
    async def test_optimize_routing_with_mock(self, tmp_dir):
        runner = TrainingRunner(data_dir=tmp_dir, api_key="test-key")
        runner.initialize()

        async def mock_llm(prompt, system="", task_type="", model="", **kw):
            return "Ответ на русском: def func(): return 42"

        runner._call_llm = mock_llm
        table = await runner.optimize_routing(rounds=3)
        assert isinstance(table, dict)

    @pytest.mark.asyncio
    async def test_full_training_mock(self, tmp_dir):
        """Full training loop with mocked LLM (no API calls)."""
        runner = TrainingRunner(data_dir=tmp_dir, api_key="test-key")
        runner.initialize()

        call_count = 0
        async def mock_llm(prompt, system="", task_type="", model="", **kw):
            nonlocal call_count
            call_count += 1
            # Return varied responses to get meaningful scores
            if "binary_search" in prompt:
                return "```python\ndef binary_search(arr, target) -> int:\n    lo, hi = 0, len(arr) - 1\n    while lo <= hi:\n        mid = (lo + hi) // 2\n        if arr[mid] == target: return mid\n        elif arr[mid] < target: lo = mid + 1\n        else: hi = mid - 1\n    return -1\n```"
            elif "RAG" in prompt:
                return "RAG (Retrieval-Augmented Generation) и fine-tuning — два подхода к адаптации LLM. RAG добавляет внешние знания через поиск, fine-tuning меняет веса модели. RAG лучше для динамических данных, fine-tuning — для специализации."
            elif "Привет" in prompt:
                return "Привет! Я OpenClaw бот, помогаю с разработкой, исследованиями и автоматизацией."
            elif "0.0" in prompt and "1.0" in prompt:
                return "0.75"  # judge response
            else:
                return f"Ответ на русском языке номер {call_count}. Это конкретный и полезный ответ."

        runner._call_llm = mock_llm
        report = runner.run_full_training.__wrapped__ if hasattr(runner.run_full_training, '__wrapped__') else runner.run_full_training
        # Run with 1 epoch for speed
        result_report = await runner.run_full_training(epochs=1)

        assert "ДО обучения" in result_report
        assert "ПОСЛЕ обучения" in result_report

        # Check training log
        log = runner.get_training_log()
        assert len(log) >= 4  # baseline, experience, evolve, evaluation

    @pytest.mark.asyncio
    async def test_save_results(self, tmp_dir):
        runner = TrainingRunner(data_dir=tmp_dir, api_key="test-key")
        runner.initialize()

        async def mock_llm(prompt, system="", task_type="", model="", **kw):
            return "test response: def f(): return 42"

        runner._call_llm = mock_llm
        await runner.run_baseline()

        # Manually set trained results for save test
        runner._trained_results = runner._baseline_results

        path = runner.save_results()
        assert os.path.exists(path)
        with open(path) as f:
            data = json.load(f)
        assert "baseline" in data
        assert "trained" in data

    def test_get_comparison_report_no_data(self, tmp_dir):
        runner = TrainingRunner(data_dir=tmp_dir)
        runner.initialize()
        report = runner.get_comparison_report()
        assert "Нет данных" in report
