"""Syntactic Evolution v12.1 — Validates that the coding pipeline
enforces modern language standards from KnowledgeStore.

Tests:
  1. Knowledge Injection in role prompts (Coder, Architect, Test_Writer)
  2. Sandbox modernization (Python 3.14, Rust 2024, TypeScript 5.8)
  3. Knowledge-First RAG recall from KnowledgeStore
  4. KnowledgeStore completeness (38 entries, 3 languages)
"""

import json
import os
import re

import pytest


# ---------------------------------------------------------------------------
# 1. Knowledge Injection into role prompts
# ---------------------------------------------------------------------------

class TestKnowledgeInjection:
    """Verify build_role_prompt() injects modern standards per role."""

    def _build(self, role_name: str) -> str:
        from src.pipeline_utils import build_role_prompt
        root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        return build_role_prompt(role_name, {"system_prompt": "base"}, root)

    def test_coder_gets_knowledge_injection(self):
        prompt = self._build("Coder")
        assert "KNOWLEDGE INJECTION" in prompt
        assert "Deferred Evaluation" in prompt
        assert "erasableSyntaxOnly" in prompt
        assert "unsafe extern" in prompt

    def test_executor_architect_gets_injection(self):
        prompt = self._build("Executor_Architect")
        assert "KNOWLEDGE INJECTION" in prompt
        assert "t-strings" in prompt
        assert "NoInfer" in prompt

    def test_executor_tools_gets_injection(self):
        prompt = self._build("Executor_Tools")
        assert "KNOWLEDGE INJECTION" in prompt

    def test_test_writer_gets_injection(self):
        prompt = self._build("Test_Writer")
        assert "KNOWLEDGE INJECTION" in prompt
        assert "Python 3.14" in prompt
        assert "Rust 2024" in prompt
        assert "TypeScript 5.8" in prompt

    def test_architect_gets_architecture_injection(self):
        prompt = self._build("Architect")
        assert "ARCHITECTURE STANDARDS" in prompt
        assert "concurrent.interpreters" in prompt
        assert "PEP 734" in prompt
        assert "--module nodenext" in prompt

    def test_planner_gets_architecture_injection(self):
        prompt = self._build("Planner")
        assert "ARCHITECTURE STANDARDS" in prompt
        assert "InterpreterPoolExecutor" in prompt

    def test_archivist_no_knowledge_injection(self):
        """Archivist is formatter/critic — should NOT get code standards."""
        prompt = self._build("Archivist")
        assert "KNOWLEDGE INJECTION" not in prompt

    def test_auditor_no_knowledge_injection(self):
        """Auditor reviews — should NOT get code generation directives."""
        prompt = self._build("Auditor")
        assert "KNOWLEDGE INJECTION" not in prompt

    def test_code_must_not_compile_on_old_versions(self):
        """The directive explicitly says code should NOT work on old versions."""
        prompt = self._build("Coder")
        assert "Python 3.10" in prompt
        assert "Rust 2021" in prompt
        assert "TypeScript 5.3" in prompt


# ---------------------------------------------------------------------------
# 2. Sandbox modernization
# ---------------------------------------------------------------------------

class TestSandboxModernization:
    """Verify sandbox configs enforce modern toolchains."""

    def test_docker_image_python314(self):
        from src.tools.dynamic_sandbox import _DOCKER_IMAGE
        assert "3.14" in _DOCKER_IMAGE

    def test_docker_image_ts_node22(self):
        from src.tools.dynamic_sandbox import _DOCKER_IMAGE_TS
        assert "22" in _DOCKER_IMAGE_TS

    def test_docker_image_rust(self):
        from src.tools.dynamic_sandbox import _DOCKER_IMAGE_RUST
        assert "rust" in _DOCKER_IMAGE_RUST
        assert "1.85" in _DOCKER_IMAGE_RUST

    def test_rust_edition_2024(self):
        from src.tools.dynamic_sandbox import _RUST_EDITION
        assert _RUST_EDITION == "2024"

    def test_ts_target_es2024(self):
        from src.tools.dynamic_sandbox import _TS_TARGET
        assert _TS_TARGET == "es2024"

    def test_validate_code_safety(self):
        from src.tools.dynamic_sandbox import validate_code
        safe, _ = validate_code("x = 1 + 2")
        assert safe
        safe, reason = validate_code("os.system('ls')")
        assert not safe
        assert "os" in reason and "system" in reason


# ---------------------------------------------------------------------------
# 3. Knowledge-First RAG recall
# ---------------------------------------------------------------------------

class TestKnowledgeFirstRAG:
    """Verify KnowledgeStore is queried based on prompt keywords."""

    def _make_store(self):
        from src.memory.knowledge_store import KnowledgeStore
        root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        ks = KnowledgeStore(project_root=root)
        ks.build()
        return ks

    def test_query_by_async_keyword(self):
        ks = self._make_store()
        results = ks.query(keyword="async")
        assert len(results) >= 2  # PY314 asyncio + Rust 2024 prelude

    def test_query_python_deferred(self):
        ks = self._make_store()
        results = ks.query(keyword="deferred")
        assert any("PEP 649" in r.pep_or_rfc for r in results)

    def test_query_rust_unsafe_extern(self):
        ks = self._make_store()
        results = ks.query(keyword="unsafe extern")
        assert any("RFC 3484" in r.pep_or_rfc for r in results)

    def test_query_typescript_erasable(self):
        ks = self._make_store()
        results = ks.query(keyword="erasable")
        assert len(results) >= 1
        assert results[0].tag == "TYPESCRIPT_MODERN_58"

    def test_query_noinfer(self):
        ks = self._make_store()
        results = ks.query(keyword="noinfer")
        assert len(results) >= 1
        assert results[0].tag == "TYPESCRIPT_MODERN_58"

    def test_get_context_for_prompt_all_tags(self):
        ks = self._make_store()
        ctx = ks.get_context_for_prompt(
            ["STANDARD_LIBRARY_PY314", "RUST_STABLE_2026", "TYPESCRIPT_MODERN_58"],
            max_entries=5,
        )
        assert "Knowledge Context" in ctx
        assert len(ctx) > 200

    def test_get_best_practices_typescript(self):
        ks = self._make_store()
        practices = ks.get_best_practices("TYPESCRIPT_MODERN_58")
        assert len(practices) >= 10
        titles = [p["title"] for p in practices]
        assert any("erasable" in t.lower() for t in titles)


# ---------------------------------------------------------------------------
# 4. KnowledgeStore completeness
# ---------------------------------------------------------------------------

class TestKnowledgeStoreCompleteness:
    """Verify all 38 entries exist with correct tags."""

    def _make_store(self):
        from src.memory.knowledge_store import KnowledgeStore
        root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        ks = KnowledgeStore(project_root=root)
        ks.build()
        return ks

    def test_total_entries(self):
        ks = self._make_store()
        stats = ks.stats()
        assert stats["total_entries"] >= 48

    def test_py314_count(self):
        ks = self._make_store()
        py = ks.query(tag="STANDARD_LIBRARY_PY314")
        assert len(py) == 20

    def test_rust2024_count(self):
        ks = self._make_store()
        rs = ks.query(tag="RUST_STABLE_2026")
        assert len(rs) == 10

    def test_ts58_count(self):
        ks = self._make_store()
        ts = ks.query(tag="TYPESCRIPT_MODERN_58")
        assert len(ts) == 18

    def test_special_skills_json_valid(self):
        root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        path = os.path.join(root, "src", "ai", "agents", "special_skills.json")
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        patterns = data["patterns"]
        assert len(patterns) >= 52  # 30 coding + 22 role-operational + extras
        langs = {p["language"] for p in patterns}
        assert "python" in langs
        assert "rust" in langs
        assert "typescript" in langs
        assert "role_pattern" in langs

    def test_special_skills_ts_patterns_exist(self):
        root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
        path = os.path.join(root, "src", "ai", "agents", "special_skills.json")
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        patterns = data["patterns"]
        ts_patterns = [p for p in patterns if p["language"] == "typescript"]
        assert len(ts_patterns) == 10
        ids = {p["pattern_id"] for p in ts_patterns}
        assert "ts58_erasable_syntax" in ids
        assert "ts54_noinfer_utility" in ids
        assert "ts55_set_methods" in ids
