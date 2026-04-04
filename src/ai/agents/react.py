"""ReAct reasoning pattern implementation.

Reference: Yao et al., "ReAct: Synergizing Reasoning and Acting
in Language Models", arXiv:2210.03629.
"""

import asyncio
import time
from typing import Any, Dict, FrozenSet, List, Optional, Tuple

from src.llm_gateway import route_llm

from src.ai.agents._shared import (
    ReActStep,
    ReActResult,
    logger,
)

_DEFAULT_TOOL_TIMEOUT_SEC = 30.0


class ReActReasoner:
    """Structured reasoning following the ReAct pattern."""

    _FINISH_ACTION = "Finish"

    def __init__(
        self,
        model: str = "",
        tool_whitelist: Optional[FrozenSet[str]] = None,
        tool_timeout_sec: float = _DEFAULT_TOOL_TIMEOUT_SEC,
    ):
        self.model = model
        self._tool_whitelist = tool_whitelist
        self._tool_timeout_sec = tool_timeout_sec
        # tool_name → callable registry
        self._tool_registry: Dict[str, Any] = {}

    async def reason(
        self,
        prompt: str,
        tools: Optional[List[Dict[str, Any]]] = None,
        max_steps: int = 5,
    ) -> ReActResult:
        tools = tools or []
        history: List[ReActStep] = []
        start = time.monotonic()

        # Filter tools against whitelist if set
        if self._tool_whitelist is not None:
            tools = [t for t in tools if t.get("name") in self._tool_whitelist]

        for step_idx in range(1, max_steps + 1):
            react_prompt = self.format_react_prompt(prompt, history, tools)
            raw = await route_llm(
                "",
                messages=[
                    {"role": "system", "content": self._system_prompt(tools)},
                    {"role": "user", "content": react_prompt},
                ],
                model=self.model,
                temperature=0.2,
            )

            thought, action, action_input = self._parse_react_output(raw)

            if action == self._FINISH_ACTION:
                history.append(
                    ReActStep(
                        step=step_idx,
                        thought=thought,
                        action=action,
                        action_input=action_input,
                        observation="[Done]",
                    )
                )
                return ReActResult(
                    answer=action_input,
                    steps=history,
                    total_steps=step_idx,
                    finished=True,
                    elapsed_sec=time.monotonic() - start,
                )

            observation = await self._execute_tool(action, action_input)
            history.append(
                ReActStep(
                    step=step_idx,
                    thought=thought,
                    action=action,
                    action_input=action_input,
                    observation=observation,
                )
            )
            logger.info(
                "react_step",
                step=step_idx,
                action=action,
                thought=thought[:120],
            )

        elapsed = time.monotonic() - start
        logger.warning("react_max_steps_reached", max_steps=max_steps)
        return ReActResult(
            answer=history[-1].thought if history else "",
            steps=history,
            total_steps=max_steps,
            finished=False,
            elapsed_sec=elapsed,
        )

    def register_tool(self, name: str, fn: Any) -> None:
        """Register a callable tool by name."""
        self._tool_registry[name] = fn

    async def _execute_tool(self, action: str, action_input: str) -> str:
        """Execute a registered tool with whitelist check and timeout."""
        if self._tool_whitelist is not None and action not in self._tool_whitelist:
            return f"[Tool '{action}' is not in the whitelist — skipped]"
        fn = self._tool_registry.get(action)
        if fn is None:
            return f"[Tool '{action}' called with input: {action_input}]"
        try:
            if asyncio.iscoroutinefunction(fn):
                result = await asyncio.wait_for(fn(action_input), timeout=self._tool_timeout_sec)
            else:
                result = fn(action_input)
            return str(result)[:2000]
        except asyncio.TimeoutError:
            logger.warning("Tool execution timed out", tool=action, timeout=self._tool_timeout_sec)
            return f"[Tool '{action}' timed out after {self._tool_timeout_sec}s]"
        except Exception as e:
            logger.warning("Tool execution error", tool=action, error=str(e))
            return f"[Tool '{action}' error: {e}]"

    def format_react_prompt(
        self,
        question: str,
        history: List[ReActStep],
        tools: Optional[List[Dict[str, Any]]] = None,
    ) -> str:
        parts = [f"Question: {question}"]
        for s in history:
            parts.append(f"Thought: {s.thought}")
            parts.append(f"Action: {s.action}")
            parts.append(f"Action Input: {s.action_input}")
            parts.append(f"Observation: {s.observation}")
        parts.append("Thought:")
        return "\n".join(parts)

    @staticmethod
    def _system_prompt(tools: List[Dict[str, Any]]) -> str:
        tool_desc = "\n".join(
            f"- {t.get('name', '?')}: {t.get('description', '')}"
            for t in tools
        )
        return (
            "You are a reasoning agent. Follow the ReAct format strictly.\n"
            "On each turn output exactly:\n"
            "Thought: <your reasoning>\n"
            "Action: <tool name or Finish>\n"
            "Action Input: <input for the tool, or final answer if Action is Finish>\n\n"
            "IMPORTANT RULES:\n"
            "- If the user asks you to WRITE code (e.g. 'write a function', 'implement'), "
            "DO NOT use list_directory or read_file. Instead, use 'Finish' and provide "
            "the code directly as the final answer.\n"
            "- Only use filesystem tools (list_directory, read_file) when the task requires "
            "READING or INSPECTING existing files.\n"
            "- Use web_search only for research/analysis tasks that need external info.\n\n"
            f"Available tools:\n{tool_desc}\n"
            "Use 'Finish' as the Action when you have the final answer."
        )

    @staticmethod
    def _parse_react_output(raw: str) -> Tuple[str, str, str]:
        thought = ""
        action = ""
        action_input = ""
        for line in raw.splitlines():
            stripped = line.strip()
            if stripped.lower().startswith("thought:"):
                thought = stripped.split(":", 1)[1].strip()
            elif stripped.lower().startswith("action:"):
                action = stripped.split(":", 1)[1].strip()
            elif stripped.lower().startswith("action input:"):
                action_input = stripped.split(":", 1)[1].strip()
        if action.lower() in ("finish", "final answer", "done"):
            action = ReActReasoner._FINISH_ACTION
        return thought, action, action_input
