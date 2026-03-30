"""Level 3: End-to-End ReAct → Sandbox → Reflexion cycle.

Tests verify the full AGI loop:
1. Agent (ReAct) generates code for a task
2. Code is sent to DynamicSandbox
3. If code fails, Reflexion produces a corrected version
4. Corrected code succeeds and is saved as a skill

Since we can't call real LLMs in unit tests, we mock route_llm to simulate
the agent's reasoning steps and focus on verifying the *plumbing*:
  - ReAct → sandbox_execute dispatch
  - Sandbox → error capture
  - ReflexionAgent → corrected code
  - Final success → skill saved
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, List
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.ai.agents._shared import ReActResult, ReActStep
from src.ai.agents.react import ReActReasoner
from src.tools.dynamic_sandbox import DynamicSandbox, SandboxResult


# ── Simulated ReAct Outputs ──────────────────────────────────────────

# Step 1: Agent generates buggy code (division by zero)
REACT_STEP1_OUTPUT = """Thought: I need to calculate the average of a list. I'll write a Python script.
Action: sandbox_execute
Action Input: {"code": "nums = []\\ntotal = sum(nums)\\navg = total / len(nums)\\nprint(f'Average: {avg}')", "language": "python", "name": "calc_average", "description": "Calculate average of list"}"""

# Step 2: After seeing the error, agent reflects and fixes the code
REACT_STEP2_OUTPUT = """Thought: The code failed with ZeroDivisionError because the list was empty. I need to use a non-empty list.
Action: sandbox_execute
Action Input: {"code": "nums = [10, 20, 30, 0]\\ntotal = sum(nums)\\navg = total / len(nums)\\nprint(f'Average: {avg}')", "language": "python", "name": "calc_average_fixed", "description": "Calculate average of list (fixed)"}"""

# Step 3: Agent finishes with the answer
REACT_STEP3_OUTPUT = """Thought: The code executed successfully and printed Average: 15.0. Task complete.
Action: Finish
Action Input: Average calculated: 15.0. Script saved as skill 'calc_average_fixed'."""


# ── E2E ReAct → Sandbox cycle ────────────────────────────────────────


class TestE2EReActSandbox:
    """Level 3a: Full ReAct → Sandbox → Reflexion → Skill Save loop."""

    @pytest.fixture
    def sandbox(self, tmp_path):
        return DynamicSandbox(base_dir=str(tmp_path / "skills"))

    @pytest.mark.asyncio
    async def test_buggy_code_detected(self, sandbox):
        """Step 1: Buggy code is executed in sandbox and fails."""
        buggy_code = (
            "nums = []\n"
            "total = sum(nums)\n"
            "avg = total / len(nums)\n"
            "print(f'Average: {avg}')"
        )
        result = await sandbox.execute(buggy_code)
        assert result.success is False
        assert "ZeroDivisionError" in result.stderr

    @pytest.mark.asyncio
    async def test_fixed_code_succeeds(self, sandbox):
        """Step 2: Corrected code with non-empty list produces correct output."""
        fixed_code = (
            "nums = [10, 20, 30, 0]\n"
            "total = sum(nums)\n"
            "avg = total / len(nums)\n"
            "print(f'Average: {avg}')"
        )
        result = await sandbox.execute(fixed_code)
        assert result.success is True
        assert "15.0" in result.stdout

    @pytest.mark.asyncio
    async def test_full_reflexion_cycle(self, sandbox):
        """Full loop: execute buggy → get error → execute fixed → save skill."""
        # Phase 1: buggy code fails
        buggy_code = "x = 1 / 0"
        r1 = await sandbox.execute(buggy_code)
        assert r1.success is False
        assert "ZeroDivisionError" in r1.stderr

        # Phase 2: agent "reflects" and produces fixed code
        fixed_code = "x = 1 / 1\nprint(f'Result: {x}')"
        r2 = await sandbox.execute(fixed_code)
        assert r2.success is True
        assert "Result: 1" in r2.stdout

        # Phase 3: save as skill
        skill = sandbox.save_as_skill(
            name="safe_division",
            description="Division with fix after reflexion",
            result=r2,
            code=fixed_code,
        )
        assert skill is not None
        assert skill.name == "safe_division"
        assert len(sandbox.skill_library.list_skills()) == 1

    @pytest.mark.asyncio
    async def test_react_parser_extracts_sandbox_action(self):
        """ReAct parser correctly identifies sandbox_execute as action."""
        reasoner = ReActReasoner(vllm_url="", model="")
        thought, action, action_input = reasoner._parse_react_output(REACT_STEP1_OUTPUT)
        assert action == "sandbox_execute"
        assert '"code"' in action_input
        # Verify the JSON is parseable
        payload = json.loads(action_input)
        assert "code" in payload
        assert payload["language"] == "python"

    @pytest.mark.asyncio
    async def test_react_parser_recognizes_finish(self):
        """ReAct parser recognizes Finish action."""
        reasoner = ReActReasoner(vllm_url="", model="")
        thought, action, action_input = reasoner._parse_react_output(REACT_STEP3_OUTPUT)
        assert action == "Finish"
        assert "15.0" in action_input

    @pytest.mark.asyncio
    async def test_mocked_react_sandbox_loop(self, sandbox):
        """Full mock: 3-step ReAct loop with sandbox execution.

        Simulates the pipeline_executor dispatch logic without real LLM calls.
        """
        # Mock responses in sequence: buggy, fixed, finish
        call_sequence = [REACT_STEP1_OUTPUT, REACT_STEP2_OUTPUT, REACT_STEP3_OUTPUT]
        call_idx = 0

        async def mock_route_llm(*args, **kwargs):
            nonlocal call_idx
            response = call_sequence[min(call_idx, len(call_sequence) - 1)]
            call_idx += 1
            return response

        reasoner = ReActReasoner(vllm_url="http://mock", model="test-model")
        tools = [
            {"name": "sandbox_execute", "description": "Execute code in sandbox"},
            {"name": "sandbox_list_skills", "description": "List saved skills"},
        ]

        with patch("src.ai.agents.react.route_llm", new=mock_route_llm):
            react_result = await reasoner.reason(
                prompt="Calculate the average of [10, 20, 30, 0]",
                tools=tools,
                max_steps=5,
            )

        # Process sandbox calls from ReAct steps (mimics pipeline_executor dispatch)
        skills_created = []
        for step in react_result.steps:
            if step.action == "sandbox_execute" and step.action_input:
                try:
                    payload = json.loads(step.action_input)
                    sb_result = await sandbox.execute(
                        code=payload.get("code", ""),
                        language=payload.get("language", "python"),
                    )
                    step.observation = f"exit={sb_result.exit_code} stdout={sb_result.stdout[:500]} stderr={sb_result.stderr[:500]}"

                    if sb_result.success:
                        skill = sandbox.save_as_skill(
                            name=payload.get("name", "auto"),
                            description=payload.get("description", ""),
                            result=sb_result,
                            code=payload.get("code", ""),
                        )
                        if skill:
                            skills_created.append(skill)
                except (json.JSONDecodeError, Exception) as e:
                    step.observation = f"Error: {e}"

        # Verify: step 1 failed (buggy code), step 2 succeeded (fixed code)
        assert react_result.total_steps == 3
        assert react_result.finished is True
        assert "15.0" in react_result.answer

        # Verify sandbox observations
        sandbox_steps = [s for s in react_result.steps if s.action == "sandbox_execute"]
        assert len(sandbox_steps) == 2
        assert "ZeroDivisionError" in sandbox_steps[0].observation
        assert "exit=0" in sandbox_steps[1].observation

        # Verify skill was saved from the successful execution
        assert len(skills_created) == 1
        assert skills_created[0].name == "calc_average_fixed"


# ── E2E Skill Reuse ──────────────────────────────────────────────────


class TestSkillReuse:
    """Level 3b: Previously saved skills can be re-executed."""

    @pytest.fixture
    def sandbox(self, tmp_path):
        return DynamicSandbox(base_dir=str(tmp_path / "skills"))

    @pytest.mark.asyncio
    async def test_execute_saved_skill(self, sandbox):
        # Save a skill
        r1 = await sandbox.execute("print('reusable')")
        skill = sandbox.save_as_skill("reusable", "Test reuse", r1, code="print('reusable')")

        # Re-execute by ID
        r2 = await sandbox.execute_skill(skill.skill_id)
        assert r2 is not None
        assert r2.success is True
        assert "reusable" in r2.stdout

    @pytest.mark.asyncio
    async def test_execute_nonexistent_skill_returns_none(self, sandbox):
        r = await sandbox.execute_skill("skill_fake_doesnotexist")
        assert r is None

    @pytest.mark.asyncio
    async def test_skill_find_and_execute(self, sandbox):
        """Agent finds a relevant skill by keyword and re-executes it."""
        code = "import math\nprint(f'Pi = {math.pi}')"
        r = await sandbox.execute(code)
        sandbox.save_as_skill("pi_calculator", "Calculates Pi value", r, code=code)

        # Another request: "I need to compute pi"
        found = sandbox.skill_library.find_skill("compute pi calculator")
        assert found is not None
        assert found.name == "pi_calculator"

        # Re-execute the found skill
        r2 = await sandbox.execute_skill(found.skill_id)
        assert r2.success
        assert "3.14159" in r2.stdout
