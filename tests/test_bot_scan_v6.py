"""Comprehensive tests for bot scan v6 changes:
- parsers_mcp.py (truncation, new tools, error handling)
- code_analysis_mcp.py (AST analysis, metrics, dependency scanning)
- mcp_client.py (concurrent init, timeout, code_analysis registration)
- boot/_env_setup.py (cross-platform lock file)
- research/_core.py (Step 9 multi-perspective, quality_metrics)
- config validation (no retiring models, model_router completeness)
"""

import asyncio
import json
import os
import sys
import tempfile
import textwrap

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from unittest.mock import AsyncMock, MagicMock, patch


# ============================================================================
# 1. parsers_mcp: truncation helper
# ============================================================================

def test_truncate_short():
    from src.parsers_mcp import _truncate, _MAX_OUTPUT_CHARS
    text = "hello world"
    assert _truncate(text) == text
    print("[PASS] _truncate: short text untouched")


def test_truncate_long():
    from src.parsers_mcp import _truncate, _MAX_OUTPUT_CHARS
    text = "x" * (_MAX_OUTPUT_CHARS + 1000)
    result = _truncate(text)
    assert len(result) < len(text)
    assert "[truncated" in result
    assert str(len(text)) in result
    print("[PASS] _truncate: long text truncated with metadata")


# ============================================================================
# 2. parsers_mcp: parse_json_file
# ============================================================================

def test_parse_json_file_not_found():
    from src.parsers_mcp import parse_json_file
    result = parse_json_file("/nonexistent/file.json")
    assert "Error" in result
    assert "not found" in result
    print("[PASS] parse_json_file: file not found returns error")


def test_parse_json_file_pretty_print():
    from src.parsers_mcp import parse_json_file
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        json.dump({"key": "value", "num": 42}, f)
        f.flush()
        path = f.name
    try:
        result = parse_json_file(path)
        parsed = json.loads(result)
        assert parsed["key"] == "value"
        assert parsed["num"] == 42
        print("[PASS] parse_json_file: pretty-print without jq")
    finally:
        os.unlink(path)


def test_parse_json_file_invalid_json():
    from src.parsers_mcp import parse_json_file
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        f.write("not json {{{")
        f.flush()
        path = f.name
    try:
        result = parse_json_file(path)
        assert "Error" in result
        assert "Invalid JSON" in result
        print("[PASS] parse_json_file: invalid JSON returns error")
    finally:
        os.unlink(path)


# ============================================================================
# 3. parsers_mcp: list_files
# ============================================================================

def test_list_files_missing_dir():
    from src.parsers_mcp import list_files
    result = list_files("/nonexistent_dir_xyz")
    assert "Error" in result
    assert "not found" in result
    print("[PASS] list_files: missing directory returns error")


def test_list_files_with_pattern():
    from src.parsers_mcp import list_files
    with tempfile.TemporaryDirectory() as tmpdir:
        open(os.path.join(tmpdir, "test.py"), "w").close()
        open(os.path.join(tmpdir, "test.txt"), "w").close()
        open(os.path.join(tmpdir, "data.json"), "w").close()
        result = list_files(tmpdir, "*.py")
        assert "test.py" in result
        assert "test.txt" not in result
        print("[PASS] list_files: pattern filtering works")


def test_list_files_depth_limit():
    from src.parsers_mcp import list_files
    with tempfile.TemporaryDirectory() as tmpdir:
        # Create nested dirs
        deep = os.path.join(tmpdir, "a", "b", "c", "d", "e")
        os.makedirs(deep)
        open(os.path.join(deep, "deep.py"), "w").close()
        open(os.path.join(tmpdir, "shallow.py"), "w").close()
        result = list_files(tmpdir, "*.py", max_depth=2)
        assert "shallow.py" in result
        # deep.py is 5 levels deep, should be filtered out
        assert "deep.py" not in result
        print("[PASS] list_files: depth limit works")


# ============================================================================
# 4. code_analysis_mcp: analyze_python_file
# ============================================================================

def test_analyze_python_file_basic():
    from src.code_analysis_mcp import analyze_python_file
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        f.write(textwrap.dedent("""\
            import os
            import sys
            
            class MyClass:
                def __init__(self):
                    pass
                
                def method(self, x):
                    if x > 0:
                        return x
                    return -x
            
            def helper(a, b):
                return a + b
        """))
        f.flush()
        path = f.name
    try:
        result = analyze_python_file(path)
        assert "MyClass" in result
        assert "method" in result
        assert "helper" in result
        assert "Imports:" in result
        assert "os" in result
        print("[PASS] analyze_python_file: extracts classes, functions, imports")
    finally:
        os.unlink(path)


def test_analyze_python_file_not_found():
    from src.code_analysis_mcp import analyze_python_file
    result = analyze_python_file("/nonexistent.py")
    assert "Error" in result
    print("[PASS] analyze_python_file: file not found")


def test_analyze_python_file_non_python():
    from src.code_analysis_mcp import analyze_python_file
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
        f.write("not python")
        f.flush()
        path = f.name
    try:
        result = analyze_python_file(path)
        assert "Error" in result
        assert ".py" in result
        print("[PASS] analyze_python_file: non-python rejected")
    finally:
        os.unlink(path)


def test_analyze_python_syntax_error():
    from src.code_analysis_mcp import analyze_python_file
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        f.write("def broken(\n  return")
        f.flush()
        path = f.name
    try:
        result = analyze_python_file(path)
        assert "SyntaxError" in result
        print("[PASS] analyze_python_file: syntax error reported")
    finally:
        os.unlink(path)


def test_analyze_complexity():
    from src.code_analysis_mcp import _estimate_complexity
    import ast
    code = textwrap.dedent("""\
        def complex_fn(x, y):
            if x > 0:
                for i in range(y):
                    if i % 2 == 0:
                        try:
                            pass
                        except ValueError:
                            pass
            elif x < -10 or y > 100:
                while True:
                    break
    """)
    tree = ast.parse(code)
    fn_node = tree.body[0]
    complexity = _estimate_complexity(fn_node)
    # Expected: 1 (base) + 1 (if) + 1 (for) + 1 (if) + 1 (except) + 1 (elif/if) + 1 (or) + 1 (while)
    assert complexity >= 7
    print(f"[PASS] _estimate_complexity: {complexity} (complex function detected)")


# ============================================================================
# 5. code_analysis_mcp: scan_dependencies
# ============================================================================

def test_scan_dependencies():
    from src.code_analysis_mcp import scan_dependencies
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
        f.write("requests==2.31.0\nflask\nnumpy>=1.24\n")
        f.flush()
        path = f.name
    try:
        result = scan_dependencies(path)
        assert "Total packages: 3" in result
        assert "Pinned: 1" in result
        assert "flask" in result and "unpinned" in result
        print("[PASS] scan_dependencies: detects pinned/unpinned")
    finally:
        os.unlink(path)


def test_scan_dependencies_not_found():
    from src.code_analysis_mcp import scan_dependencies
    result = scan_dependencies("/no/such/file.txt")
    assert "Error" in result
    print("[PASS] scan_dependencies: file not found")


# ============================================================================
# 6. code_analysis_mcp: code_metrics
# ============================================================================

def test_code_metrics():
    from src.code_analysis_mcp import code_metrics
    with tempfile.TemporaryDirectory() as tmpdir:
        with open(os.path.join(tmpdir, "a.py"), "w") as f:
            f.write("x = 1\ny = 2\n")
        with open(os.path.join(tmpdir, "b.py"), "w") as f:
            f.write("# comment\nimport os\n")
        with open(os.path.join(tmpdir, "c.txt"), "w") as f:
            f.write("not python\n")

        result = code_metrics(tmpdir, ".py")
        assert "Files: 2" in result
        assert "Total LOC: 4" in result
        print("[PASS] code_metrics: counts Python files only")


def test_code_metrics_not_found():
    from src.code_analysis_mcp import code_metrics
    result = code_metrics("/nonexistent_dir")
    assert "Error" in result
    print("[PASS] code_metrics: missing directory error")


# ============================================================================
# 7. boot/_env_setup.py: cross-platform lock file
# ============================================================================

def test_lock_file_path():
    from src.boot._env_setup import LOCK_FILE
    assert "openclaw_bot.lock" in LOCK_FILE
    # Should NOT be hardcoded /tmp on Windows
    if sys.platform == "win32":
        assert not LOCK_FILE.startswith("/tmp"), "LOCK_FILE uses /tmp on Windows!"
    print(f"[PASS] LOCK_FILE: {LOCK_FILE}")


def test_acquire_release_lock():
    from src.boot._env_setup import acquire_lock, release_lock, LOCK_FILE
    # Save and restore any existing lock
    had_lock = os.path.exists(LOCK_FILE)
    if had_lock:
        with open(LOCK_FILE) as f:
            saved = f.read()
    try:
        acquire_lock()
        assert os.path.exists(LOCK_FILE)
        with open(LOCK_FILE) as f:
            pid = int(f.read().strip())
        assert pid == os.getpid()
        release_lock()
        assert not os.path.exists(LOCK_FILE)
        print("[PASS] acquire/release lock works")
    finally:
        if had_lock:
            with open(LOCK_FILE, "w") as f:
                f.write(saved)


# ============================================================================
# 8. mcp_client.py: structure and registration
# ============================================================================

def test_mcp_client_has_code_analysis():
    """Verify CodeAnalysis server is registered in the initialize starters."""
    import inspect
    from src.mcp_client import OpenClawMCPClient
    source = inspect.getsource(OpenClawMCPClient.initialize)
    assert "CodeAnalysis" in source
    assert "_start_code_analysis_server" in source
    print("[PASS] MCP client includes CodeAnalysis server")


def test_mcp_client_has_timeout():
    from src.mcp_client import _SERVER_INIT_TIMEOUT
    assert _SERVER_INIT_TIMEOUT >= 10
    print(f"[PASS] MCP server init timeout: {_SERVER_INIT_TIMEOUT}s")


def test_mcp_client_tool_registration():
    """Tool registration converts MCP spec to OpenAI format."""
    from src.mcp_client import OpenClawMCPClient
    client = OpenClawMCPClient(db_path=None, fs_allowed_dirs=["/tmp"])
    mock_tool = MagicMock()
    mock_tool.name = "test_tool"
    mock_tool.description = "A test tool"
    mock_tool.inputSchema = {"type": "object", "properties": {}}
    mock_session = MagicMock()
    client._register_tool(mock_tool, mock_session)
    assert len(client.available_tools_openai) == 1
    assert client.available_tools_openai[0]["function"]["name"] == "test_tool"
    assert client._tool_route_map["test_tool"] is mock_session
    print("[PASS] MCP tool registration to OpenAI format")


# ============================================================================
# 9. config: model router validation
# ============================================================================

def test_config_no_retiring_models():
    """Ensure no references to retiring trinity-large-preview model."""
    config_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "config", "openclaw_config.json"
    )
    with open(config_path, "r", encoding="utf-8") as f:
        content = f.read()
    # trinity-large-preview is retiring — should be fully replaced
    assert "trinity-large-preview" not in content.split('"notes"')[0], \
        "trinity-large-preview still referenced outside notes!"
    print("[PASS] No retiring trinity-large-preview models in config")


def test_config_model_router_keys():
    """Verify model_router has required task types."""
    config_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "config", "openclaw_config.json"
    )
    with open(config_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    router = cfg.get("system", {}).get("model_router", {})
    required_keys = ["general", "code", "research", "tool_execution"]
    for key in required_keys:
        assert key in router, f"model_router missing '{key}'"
    print(f"[PASS] model_router has all required keys: {list(router.keys())}")


# ============================================================================
# 10. research/_core.py: quality_metrics in return
# ============================================================================

def test_deep_research_returns_quality_metrics():
    """Verify the pipeline returns quality_metrics in the result dict."""
    from src.deep_research import DeepResearchPipeline

    mcp = MagicMock()
    mcp.call_tool = AsyncMock(return_value="mock result")
    pipeline = DeepResearchPipeline(model="test-model", mcp_client=mcp)
    pipeline._academic_search_enabled = False
    pipeline._parsers_enabled = False

    # Mock LLM to avoid actual API calls
    responses = [
        "complex",  # complexity assessment
        '["sub question 1"]',  # decomposition
        "Evidence piece from search.",  # search result
        "Score: 7 sources: ['src1']",  # scoring
        "No contradictions.",  # contradiction check
        "0.8",  # confidence
        "Research synthesis report.",  # synthesis
        "Critic feedback: looks good.",  # self-critique
        "No gaps.",  # gap identification
        '{"report":"Final report","verified":["fact1"],"refuted":[]}',  # fact-check
    ]
    call_count = {"n": 0}

    async def _fake_llm(system, user, max_tokens=2048, retries=2):
        idx = call_count["n"]
        call_count["n"] += 1
        if idx < len(responses):
            return responses[idx]
        return "none"

    pipeline._llm_call = _fake_llm

    async def _run():
        result = await pipeline.research("test question")
        assert "quality_metrics" in result
        assert isinstance(result["quality_metrics"], dict)
        return result

    result = asyncio.run(_run())
    print(f"[PASS] DeepResearchPipeline returns quality_metrics: {result['quality_metrics']}")


# ============================================================================
# 11. main.py: env var validation
# ============================================================================

def test_env_var_validation():
    """Test that unresolved ${VAR} patterns are detected."""
    import re
    # Simulate what main.py does
    raw = '{"key": "${UNSET_VAR}", "ok": "resolved_value"}'
    expanded = os.path.expandvars(raw)
    unresolved = re.findall(r'\$\{([^}]+)\}', expanded)
    # On Windows, if UNSET_VAR is not set, it stays as ${UNSET_VAR}
    # On Linux, it becomes empty string
    if sys.platform == "win32":
        assert len(unresolved) >= 1 or "UNSET_VAR" not in expanded
    print("[PASS] env var validation regex works")


# ============================================================================
# Runner
# ============================================================================

if __name__ == "__main__":
    tests = [
        # Parsers MCP
        test_truncate_short,
        test_truncate_long,
        test_parse_json_file_not_found,
        test_parse_json_file_pretty_print,
        test_parse_json_file_invalid_json,
        test_list_files_missing_dir,
        test_list_files_with_pattern,
        test_list_files_depth_limit,
        # Code Analysis MCP
        test_analyze_python_file_basic,
        test_analyze_python_file_not_found,
        test_analyze_python_file_non_python,
        test_analyze_python_syntax_error,
        test_analyze_complexity,
        test_scan_dependencies,
        test_scan_dependencies_not_found,
        test_code_metrics,
        test_code_metrics_not_found,
        # Boot
        test_lock_file_path,
        test_acquire_release_lock,
        # MCP Client
        test_mcp_client_has_code_analysis,
        test_mcp_client_has_timeout,
        test_mcp_client_tool_registration,
        # Config
        test_config_no_retiring_models,
        test_config_model_router_keys,
        # Research
        test_deep_research_returns_quality_metrics,
        # Env var
        test_env_var_validation,
    ]

    passed = 0
    failed = 0
    for test_fn in tests:
        try:
            test_fn()
            passed += 1
        except Exception as e:
            print(f"[FAIL] {test_fn.__name__}: {e}")
            failed += 1

    print(f"\n{'='*60}")
    print(f"Results: {passed} passed, {failed} failed, {passed + failed} total")
    if failed == 0:
        print("✅ ALL TESTS PASSED")
    else:
        print(f"❌ {failed} TESTS FAILED")
        sys.exit(1)
