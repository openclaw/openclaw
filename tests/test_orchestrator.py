"""Unit tests for orchestrator.parse_ron_response()."""
import json
import sys
from pathlib import Path

SCRIPTS_DIR = str(Path(__file__).parent.parent / "scripts")
sys.path.insert(0, SCRIPTS_DIR)

from orchestrator import parse_ron_response


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_tasks_json(tasks):
    """Build a JSON string with a 'tasks' key."""
    return json.dumps({"tasks": tasks})


def _valid_task(**overrides):
    """Return a minimal valid task dict with optional overrides."""
    t = {"agent": "codex", "title": "Fix bug", "body": "Fix the auth bug"}
    t.update(overrides)
    return t


# ---------------------------------------------------------------------------
# Clean JSON input
# ---------------------------------------------------------------------------

class TestCleanJsonInput:
    def test_single_task(self):
        payload = _make_tasks_json([_valid_task()])
        result = parse_ron_response(payload)
        assert len(result) == 1
        assert result[0]["agent"] == "codex"
        assert result[0]["title"] == "Fix bug"
        assert result[0]["body"] == "Fix the auth bug"
        assert result[0]["priority"] == "normal"

    def test_multiple_valid_tasks(self):
        tasks = [
            _valid_task(agent="codex", title="Task 1"),
            _valid_task(agent="cowork", title="Task 2"),
            _valid_task(agent="ron", title="Task 3"),
        ]
        result = parse_ron_response(_make_tasks_json(tasks))
        assert len(result) == 3
        agents = {t["agent"] for t in result}
        assert agents == {"codex", "cowork", "ron"}

    def test_priority_preserved(self):
        result = parse_ron_response(_make_tasks_json([_valid_task(priority="high")]))
        assert result[0]["priority"] == "high"

    def test_invalid_priority_defaults_to_normal(self):
        result = parse_ron_response(_make_tasks_json([_valid_task(priority="urgent")]))
        assert result[0]["priority"] == "normal"


# ---------------------------------------------------------------------------
# Markdown code block wrapping
# ---------------------------------------------------------------------------

class TestMarkdownCodeBlock:
    def test_json_fenced_block(self):
        raw = '```json\n' + _make_tasks_json([_valid_task()]) + '\n```'
        result = parse_ron_response(raw)
        assert len(result) == 1
        assert result[0]["agent"] == "codex"

    def test_unfenced_block(self):
        raw = '```\n' + _make_tasks_json([_valid_task(agent="cowork")]) + '\n```'
        result = parse_ron_response(raw)
        assert len(result) == 1
        assert result[0]["agent"] == "cowork"

    def test_surrounding_text_with_code_block(self):
        raw = 'Here is the plan:\n```json\n' + _make_tasks_json([_valid_task()]) + '\n```\nDone.'
        result = parse_ron_response(raw)
        assert len(result) == 1


# ---------------------------------------------------------------------------
# Invalid agent name
# ---------------------------------------------------------------------------

class TestInvalidAgent:
    def test_unknown_agent_rejected(self):
        result = parse_ron_response(_make_tasks_json([_valid_task(agent="unknown")]))
        assert result == []

    def test_mixed_valid_and_invalid(self):
        tasks = [
            _valid_task(agent="codex", title="Good"),
            _valid_task(agent="badbot", title="Bad"),
            _valid_task(agent="guardian", title="Also good"),
        ]
        result = parse_ron_response(_make_tasks_json(tasks))
        assert len(result) == 2
        agents = [t["agent"] for t in result]
        assert "badbot" not in agents
        assert "codex" in agents
        assert "guardian" in agents


# ---------------------------------------------------------------------------
# Per-agent cap (AGENT_CAP = 2)
# ---------------------------------------------------------------------------

class TestAgentCap:
    def test_third_task_for_same_agent_truncated(self):
        tasks = [
            _valid_task(agent="codex", title="T1"),
            _valid_task(agent="codex", title="T2"),
            _valid_task(agent="codex", title="T3"),
        ]
        result = parse_ron_response(_make_tasks_json(tasks))
        assert len(result) == 2
        assert all(t["agent"] == "codex" for t in result)

    def test_cap_per_agent_independent(self):
        tasks = [
            _valid_task(agent="codex", title="C1"),
            _valid_task(agent="codex", title="C2"),
            _valid_task(agent="cowork", title="W1"),
            _valid_task(agent="cowork", title="W2"),
            _valid_task(agent="codex", title="C3"),
            _valid_task(agent="cowork", title="W3"),
        ]
        result = parse_ron_response(_make_tasks_json(tasks))
        assert len(result) == 4
        codex_tasks = [t for t in result if t["agent"] == "codex"]
        cowork_tasks = [t for t in result if t["agent"] == "cowork"]
        assert len(codex_tasks) == 2
        assert len(cowork_tasks) == 2


# ---------------------------------------------------------------------------
# Total cap (QUEUE_CAP = 6)
# ---------------------------------------------------------------------------

class TestQueueCap:
    def test_total_cap_enforced(self):
        agents = ["ron", "codex", "cowork", "guardian", "data-analyst"]
        tasks = []
        for agent in agents:
            tasks.append(_valid_task(agent=agent, title=f"{agent}-T1"))
            tasks.append(_valid_task(agent=agent, title=f"{agent}-T2"))
        # 10 tasks, per-agent cap allows 2 each = 10, but QUEUE_CAP = 6
        result = parse_ron_response(_make_tasks_json(tasks))
        assert len(result) == 6


# ---------------------------------------------------------------------------
# None / empty / plain text / malformed JSON
# ---------------------------------------------------------------------------

class TestEdgeCases:
    def test_none_input(self):
        assert parse_ron_response(None) == []

    def test_empty_string(self):
        assert parse_ron_response("") == []

    def test_whitespace_only(self):
        assert parse_ron_response("   \n  ") == []

    def test_plain_text_no_json(self):
        assert parse_ron_response("I don't have any tasks for you.") == []

    def test_malformed_json(self):
        assert parse_ron_response('{"tasks": [{"agent": "codex"') == []

    def test_malformed_json_no_crash(self):
        # Garbage input should never raise
        result = parse_ron_response("{{{bad json}}}}")
        assert result == []


# ---------------------------------------------------------------------------
# Missing required fields
# ---------------------------------------------------------------------------

class TestMissingFields:
    def test_missing_title(self):
        task = {"agent": "codex", "body": "Some body"}
        result = parse_ron_response(_make_tasks_json([task]))
        assert result == []

    def test_missing_body(self):
        task = {"agent": "codex", "title": "Some title"}
        result = parse_ron_response(_make_tasks_json([task]))
        assert result == []

    def test_missing_agent(self):
        task = {"title": "Some title", "body": "Some body"}
        result = parse_ron_response(_make_tasks_json([task]))
        assert result == []

    def test_empty_title(self):
        result = parse_ron_response(_make_tasks_json([_valid_task(title="")]))
        assert result == []

    def test_empty_body(self):
        result = parse_ron_response(_make_tasks_json([_valid_task(body="")]))
        assert result == []

    def test_non_dict_task_entry(self):
        result = parse_ron_response(_make_tasks_json(["not a dict", 42, None]))
        assert result == []

    def test_tasks_not_a_list(self):
        result = parse_ron_response(json.dumps({"tasks": "not a list"}))
        assert result == []


# ---------------------------------------------------------------------------
# Field truncation
# ---------------------------------------------------------------------------

class TestFieldTruncation:
    def test_title_truncated_to_80(self):
        long_title = "A" * 200
        result = parse_ron_response(_make_tasks_json([_valid_task(title=long_title)]))
        assert len(result[0]["title"]) == 80

    def test_body_truncated_to_500(self):
        long_body = "B" * 1000
        result = parse_ron_response(_make_tasks_json([_valid_task(body=long_body)]))
        assert len(result[0]["body"]) == 500
