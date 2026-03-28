"""Level 1: Security Unit Tests — DynamicSandbox deny-list and isolation.

Tests verify that:
- Malicious code patterns are blocked by the static validator
- Safe code passes validation
- Subprocess fallback executes and captures output correctly
- Skill Library save/load/dedup cycle works
- Output truncation respects the 32K cap
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import tempfile
import time

import pytest

from src.tools.dynamic_sandbox import (
    DynamicSandbox,
    LocalSkill,
    SandboxResult,
    SkillLibrary,
    _MAX_OUTPUT_CHARS,
    validate_code,
)


# ── Deny-list validation ───────────────────────────────────────────────


class TestValidateCode:
    """Level 1a: Static code validation catches all dangerous patterns."""

    @pytest.mark.parametrize(
        "malicious_code,expected_pattern",
        [
            ('import os; os.system("rm -rf /")', r"os\.system"),
            ('subprocess.call("ls", shell=True)', r"subprocess"),
            ('eval("2+2")', r"eval"),
            ('exec("print(1)")', r"exec"),
            ('__import__("os")', r"__import__"),
            ('shutil.rmtree("/etc")', r"shutil\.rmtree"),
            ('open("/etc/passwd")', r"open"),
            ("import socket; socket.socket()", r"socket"),
            ("import ctypes", r"ctypes"),
            ("import pickle; pickle.load(f)", r"pickle\.loads?"),
        ],
        ids=[
            "os_system",
            "subprocess_shell",
            "eval",
            "exec",
            "dunder_import",
            "shutil_rmtree_root",
            "open_etc_passwd",
            "socket_network",
            "ctypes_ffi",
            "pickle_deser",
        ],
    )
    def test_deny_blocks_malicious_code(self, malicious_code: str, expected_pattern: str):
        ok, reason = validate_code(malicious_code)
        assert ok is False, f"Expected deny for: {malicious_code}"
        assert expected_pattern in reason

    def test_safe_code_passes(self):
        safe_snippets = [
            "print('hello world')",
            "x = [i**2 for i in range(100)]",
            "import math; print(math.pi)",
            "data = {'key': 'value'}; print(data)",
            "result = sum(range(1000))",
        ]
        for code in safe_snippets:
            ok, reason = validate_code(code)
            assert ok is True, f"Safe code was blocked: {code} — reason: {reason}"

    def test_multiline_malicious(self):
        """Deny-list catches patterns even in multiline scripts."""
        code = "import json\nimport os\nos.system('whoami')\nprint('done')"
        ok, reason = validate_code(code)
        assert ok is False
        assert "os" in reason and "system" in reason

    def test_obfuscation_not_bypassed(self):
        """Direct calls to dangerous builtins are caught."""
        # eval with whitespace
        ok, _ = validate_code("eval (user_input)")
        assert ok is False

    def test_empty_code_is_safe(self):
        ok, reason = validate_code("")
        assert ok is True

    def test_comment_only_is_safe(self):
        ok, _ = validate_code("# this is just a comment\n# nothing to execute")
        assert ok is True


# ── Sandbox Execution (subprocess fallback) ──────────────────────────


class TestSandboxExecution:
    """Level 1b: DynamicSandbox executes safe code and rejects dangerous code."""

    @pytest.fixture
    def sandbox(self, tmp_path):
        return DynamicSandbox(base_dir=str(tmp_path / "skills"))

    @pytest.mark.asyncio
    async def test_execute_safe_code(self, sandbox):
        result = await sandbox.execute("print('Hello Phase 7')")
        assert result.success is True
        assert result.exit_code == 0
        assert "Hello Phase 7" in result.stdout
        assert result.method in ("docker", "subprocess")
        assert result.elapsed_sec >= 0

    @pytest.mark.asyncio
    async def test_execute_math(self, sandbox):
        result = await sandbox.execute("print(2 ** 10)")
        assert result.success is True
        assert "1024" in result.stdout

    @pytest.mark.asyncio
    async def test_execute_denied_code_never_runs(self, sandbox):
        """Malicious code is blocked BEFORE execution."""
        result = await sandbox.execute('import os; os.system("echo pwned")')
        assert result.success is False
        assert result.exit_code == -2  # validation rejection code
        assert "Safety validation failed" in result.stderr
        assert result.method == "validation"

    @pytest.mark.asyncio
    async def test_execute_syntax_error(self, sandbox):
        result = await sandbox.execute("def broken(:\n  pass")
        assert result.success is False
        assert result.exit_code != 0
        assert "SyntaxError" in result.stderr or "invalid syntax" in result.stderr

    @pytest.mark.asyncio
    async def test_execute_runtime_error(self, sandbox):
        result = await sandbox.execute("x = 1 / 0")
        assert result.success is False
        assert "ZeroDivisionError" in result.stderr

    @pytest.mark.asyncio
    async def test_execute_timeout(self, sandbox):
        """Long-running code respects timeout."""
        import sys
        if sys.platform == "win32":
            pytest.skip("Timeout cleanup flaky on Windows due to temp dir locks")
        result = await sandbox.execute("import time; time.sleep(120)", timeout=2)
        assert result.success is False
        assert "Timeout" in result.stderr or result.exit_code == -1

    @pytest.mark.asyncio
    async def test_script_hash_deterministic(self, sandbox):
        code = "print('hash_test')"
        r1 = await sandbox.execute(code)
        r2 = await sandbox.execute(code)
        assert r1.script_hash == r2.script_hash
        expected = hashlib.sha256(code.encode()).hexdigest()
        assert r1.script_hash == expected

    @pytest.mark.asyncio
    async def test_output_truncation(self, sandbox):
        """Output longer than _MAX_OUTPUT_CHARS gets truncated."""
        # Generate output slightly over the limit
        code = f"print('A' * {_MAX_OUTPUT_CHARS + 5000})"
        result = await sandbox.execute(code)
        assert result.success is True
        assert len(result.stdout) <= _MAX_OUTPUT_CHARS

    @pytest.mark.asyncio
    async def test_network_attempt_fails_in_code(self, sandbox):
        """socket import is blocked by deny-list."""
        result = await sandbox.execute("import socket; s = socket.socket()")
        assert result.success is False
        assert "Safety validation failed" in result.stderr

    @pytest.mark.asyncio
    async def test_env_sanitized(self, sandbox):
        """Sensitive env vars are not leaked to subprocess."""
        os.environ["TEST_SECRET_KEY"] = "should_not_appear"
        try:
            result = await sandbox.execute(
                "import os; print(os.environ.get('TEST_SECRET_KEY', 'CLEAN'))"
            )
            assert result.success is True
            assert "CLEAN" in result.stdout
            assert "should_not_appear" not in result.stdout
        finally:
            del os.environ["TEST_SECRET_KEY"]


# ── Skill Library ────────────────────────────────────────────────────


class TestSkillLibrary:
    """Level 1c: SkillLibrary persistence, dedup, and search."""

    @pytest.fixture
    def lib(self, tmp_path):
        return SkillLibrary(base_dir=str(tmp_path / "skills"))

    def test_save_and_list(self, lib):
        skill = lib.save_skill(
            name="test_skill",
            description="A test skill",
            code="print('skill')",
            language="python",
        )
        assert skill.skill_id.startswith("skill_")
        assert skill.success_count == 1
        skills = lib.list_skills()
        assert len(skills) == 1
        assert skills[0]["name"] == "test_skill"

    def test_dedup_increments_success(self, lib):
        code = "print('dedup')"
        s1 = lib.save_skill("first", "First save", code)
        s2 = lib.save_skill("first", "First save", code)
        assert s1.skill_id == s2.skill_id
        assert s2.success_count == 2

    def test_persistence_across_instances(self, tmp_path):
        base = str(tmp_path / "skills")
        lib1 = SkillLibrary(base_dir=base)
        lib1.save_skill("persist_test", "Persistence", "print(42)")
        # New instance should load from disk
        lib2 = SkillLibrary(base_dir=base)
        skills = lib2.list_skills()
        assert len(skills) == 1
        assert skills[0]["name"] == "persist_test"

    def test_find_skill_by_keyword(self, lib):
        lib.save_skill("csv_parser", "Parses CSV files into dict", "import csv")
        lib.save_skill("json_formatter", "Formats JSON nicely", "import json")
        found = lib.find_skill("parse csv")
        assert found is not None
        assert found.name == "csv_parser"

    def test_find_skill_no_match(self, lib):
        lib.save_skill("unrelated", "Does nothing", "pass")
        assert lib.find_skill("quantum physics") is None

    def test_record_failure(self, lib):
        skill = lib.save_skill("flaky", "Sometimes fails", "print(1)")
        lib.record_failure(skill.skill_id)
        # Reload and check
        lib2 = SkillLibrary(base_dir=lib._dir)
        reloaded = lib2._skills[skill.skill_id]
        assert reloaded.fail_count == 1

    def test_script_file_created(self, lib):
        skill = lib.save_skill("file_test", "Check file", "print('hello')")
        script_path = os.path.join(lib._dir, f"{skill.skill_id}.py")
        assert os.path.exists(script_path)
        with open(script_path) as f:
            assert f.read() == "print('hello')"


# ── DynamicSandbox.save_as_skill ────────────────────────────────────


class TestSandboxSkillSave:
    """Level 1d: save_as_skill only persists successful executions."""

    @pytest.fixture
    def sandbox(self, tmp_path):
        return DynamicSandbox(base_dir=str(tmp_path / "skills"))

    @pytest.mark.asyncio
    async def test_save_successful_execution(self, sandbox):
        result = await sandbox.execute("print('saveable')")
        assert result.success
        skill = sandbox.save_as_skill(
            "saveable_skill", "Prints saveable", result, code="print('saveable')"
        )
        assert skill is not None
        assert skill.name == "saveable_skill"
        assert len(sandbox.skill_library.list_skills()) == 1

    @pytest.mark.asyncio
    async def test_refuse_save_failed_execution(self, sandbox):
        result = await sandbox.execute("raise ValueError('boom')")
        assert not result.success
        skill = sandbox.save_as_skill("bad", "Should not save", result, code="raise ValueError('boom')")
        assert skill is None
        assert len(sandbox.skill_library.list_skills()) == 0

    @pytest.mark.asyncio
    async def test_synthesize_and_run_success(self, sandbox):
        result, skill = await sandbox.synthesize_and_run(
            task_description="Calculate fibonacci 10",
            generated_code="a, b = 0, 1\nfor _ in range(10): a, b = b, a+b\nprint(a)",
        )
        assert result.success
        assert "55" in result.stdout
        assert skill is not None
        assert "fibonacci" in skill.name.lower()

    @pytest.mark.asyncio
    async def test_synthesize_and_run_failure(self, sandbox):
        result, skill = await sandbox.synthesize_and_run(
            task_description="Bad math",
            generated_code="print(1/0)",
        )
        assert not result.success
        assert skill is None
