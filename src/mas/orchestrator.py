"""
MAS Orchestrator — manages agent lifecycle, task routing, and autonomous execution.

Architecture:
- Each agent is defined by AgentDefinition (role, model tier, system prompt, tools)
- AgentOrchestrator registers agents, routes tasks, and runs the autonomous loop
- Tasks are dispatched based on intent classification → agent capability matching
- OpenRouter is the primary LLM provider (cloud-only)

The orchestrator supports:
- Parallel agent execution for independent tasks
- Sequential chain execution for pipeline workflows (brigades)
- Autonomous loop with configurable interval for background processing
- Agent health monitoring and auto-recovery
"""

from __future__ import annotations

import asyncio
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Coroutine, Dict, List, Optional

import structlog

logger = structlog.get_logger("MAS.Orchestrator")


class AgentState(str, Enum):
    """Agent lifecycle states."""
    IDLE = "idle"
    RUNNING = "running"
    PAUSED = "paused"
    ERROR = "error"
    STOPPED = "stopped"


@dataclass
class AgentDefinition:
    """Declarative agent specification."""
    agent_id: str
    name: str
    role: str  # e.g. "planner", "executor", "researcher", "parser"
    model_tier: str = "balanced"  # "fast_free", "balanced", "premium", "reasoning"
    system_prompt: str = ""
    capabilities: List[str] = field(default_factory=list)  # e.g. ["coding", "research", "parsing"]
    tools: List[str] = field(default_factory=list)  # MCP tool names this agent can use
    max_concurrent_tasks: int = 1
    timeout_sec: int = 120
    brigade: str = "OpenClaw"  # which brigade this agent belongs to


@dataclass
class TaskResult:
    """Result from an agent task execution."""
    task_id: str
    agent_id: str
    status: str  # "completed", "failed", "timeout"
    output: str = ""
    error: str = ""
    duration_sec: float = 0.0
    model_used: str = ""
    tokens_used: int = 0


@dataclass
class _AgentRuntime:
    """Internal runtime state for a registered agent."""
    definition: AgentDefinition
    state: AgentState = AgentState.IDLE
    current_task_id: Optional[str] = None
    tasks_completed: int = 0
    tasks_failed: int = 0
    last_active: float = field(default_factory=time.time)
    consecutive_errors: int = 0


class AgentOrchestrator:
    """Manages agent lifecycle, task dispatch, and autonomous execution loop.

    Usage:
        orch = AgentOrchestrator(config, openrouter_client, model_selector)
        orch.register_agent(AgentDefinition(...))
        result = await orch.dispatch("research", "What is ClawHub?")
        # or run autonomous loop:
        await orch.run_autonomous(interval_sec=60)
    """

    def __init__(
        self,
        config: Dict[str, Any],
        inference_fn: Optional[Callable[..., Coroutine]] = None,
        model_selector: Any = None,
    ):
        self._config = config
        self._inference_fn = inference_fn  # async callable for LLM inference
        self._model_selector = model_selector
        self._agents: Dict[str, _AgentRuntime] = {}
        self._task_queue: asyncio.Queue[Dict[str, Any]] = asyncio.Queue()
        self._results: Dict[str, TaskResult] = {}
        self._autonomous_running = False
        self._autonomous_task: Optional[asyncio.Task] = None

        logger.info("AgentOrchestrator initialized")

    # ------------------------------------------------------------------
    # Agent registration
    # ------------------------------------------------------------------

    def register_agent(self, definition: AgentDefinition) -> None:
        """Register an agent with the orchestrator."""
        if definition.agent_id in self._agents:
            logger.warning("Agent already registered, updating", agent_id=definition.agent_id)
        self._agents[definition.agent_id] = _AgentRuntime(definition=definition)
        logger.info(
            "Agent registered",
            agent_id=definition.agent_id,
            name=definition.name,
            role=definition.role,
            capabilities=definition.capabilities,
        )

    def unregister_agent(self, agent_id: str) -> None:
        """Remove an agent from the orchestrator."""
        if agent_id in self._agents:
            del self._agents[agent_id]
            logger.info("Agent unregistered", agent_id=agent_id)

    def list_agents(self) -> List[Dict[str, Any]]:
        """List all registered agents with their current state."""
        return [
            {
                "agent_id": rt.definition.agent_id,
                "name": rt.definition.name,
                "role": rt.definition.role,
                "state": rt.state.value,
                "capabilities": rt.definition.capabilities,
                "tasks_completed": rt.tasks_completed,
                "tasks_failed": rt.tasks_failed,
                "consecutive_errors": rt.consecutive_errors,
            }
            for rt in self._agents.values()
        ]

    # ------------------------------------------------------------------
    # Task dispatch
    # ------------------------------------------------------------------

    async def dispatch(
        self,
        capability: str,
        prompt: str,
        context: Optional[Dict[str, Any]] = None,
        force_agent_id: Optional[str] = None,
    ) -> TaskResult:
        """Dispatch a task to the best-fit agent.

        Args:
            capability: Required capability (e.g. "research", "coding", "parsing")
            prompt: User prompt or task description
            context: Optional additional context (memory, previous results)
            force_agent_id: Override agent selection

        Returns:
            TaskResult with output or error
        """
        task_id = str(uuid.uuid4())[:8]

        # Select agent
        agent_rt = self._select_agent(capability, force_agent_id)
        if not agent_rt:
            return TaskResult(
                task_id=task_id,
                agent_id="none",
                status="failed",
                error=f"No available agent for capability: {capability}",
            )

        defn = agent_rt.definition
        logger.info(
            "Dispatching task",
            task_id=task_id,
            agent=defn.name,
            capability=capability,
            model_tier=defn.model_tier,
        )

        # Mark agent as running
        agent_rt.state = AgentState.RUNNING
        agent_rt.current_task_id = task_id
        start_time = time.time()

        try:
            output = await self._execute_agent_task(defn, prompt, context or {})
            duration = time.time() - start_time

            agent_rt.state = AgentState.IDLE
            agent_rt.current_task_id = None
            agent_rt.tasks_completed += 1
            agent_rt.consecutive_errors = 0
            agent_rt.last_active = time.time()

            result = TaskResult(
                task_id=task_id,
                agent_id=defn.agent_id,
                status="completed",
                output=output,
                duration_sec=round(duration, 2),
            )
            self._results[task_id] = result
            logger.info("Task completed", task_id=task_id, agent=defn.name, duration=f"{duration:.1f}s")
            return result

        except asyncio.TimeoutError:
            duration = time.time() - start_time
            agent_rt.state = AgentState.IDLE
            agent_rt.current_task_id = None
            agent_rt.tasks_failed += 1
            agent_rt.consecutive_errors += 1

            result = TaskResult(
                task_id=task_id,
                agent_id=defn.agent_id,
                status="timeout",
                error=f"Agent {defn.name} timed out after {defn.timeout_sec}s",
                duration_sec=round(duration, 2),
            )
            self._results[task_id] = result
            logger.warning("Task timeout", task_id=task_id, agent=defn.name)
            return result

        except Exception as e:
            duration = time.time() - start_time
            agent_rt.state = AgentState.ERROR if agent_rt.consecutive_errors >= 3 else AgentState.IDLE
            agent_rt.current_task_id = None
            agent_rt.tasks_failed += 1
            agent_rt.consecutive_errors += 1

            result = TaskResult(
                task_id=task_id,
                agent_id=defn.agent_id,
                status="failed",
                error=str(e),
                duration_sec=round(duration, 2),
            )
            self._results[task_id] = result
            logger.error("Task failed", task_id=task_id, agent=defn.name, error=str(e))
            return result

    # ------------------------------------------------------------------
    # Autonomous loop
    # ------------------------------------------------------------------

    async def run_autonomous(self, interval_sec: float = 60.0) -> None:
        """Start the autonomous processing loop.

        Checks the task queue periodically and dispatches tasks to agents.
        """
        if self._autonomous_running:
            logger.warning("Autonomous loop already running")
            return

        self._autonomous_running = True
        logger.info("Autonomous loop started", interval_sec=interval_sec)

        while self._autonomous_running:
            try:
                # Process any queued tasks
                while not self._task_queue.empty():
                    task_data = self._task_queue.get_nowait()
                    capability = task_data.get("capability", "general")
                    prompt = task_data.get("prompt", "")
                    context = task_data.get("context", {})
                    await self.dispatch(capability, prompt, context)

                # Health check: recover agents in error state
                self._health_check()

            except Exception as e:
                logger.error("Autonomous loop error", error=str(e))

            await asyncio.sleep(interval_sec)

    def stop_autonomous(self) -> None:
        """Stop the autonomous processing loop."""
        self._autonomous_running = False
        logger.info("Autonomous loop stop requested")

    def enqueue_task(self, capability: str, prompt: str, context: Optional[Dict] = None) -> None:
        """Add a task to the queue for autonomous processing."""
        self._task_queue.put_nowait({
            "capability": capability,
            "prompt": prompt,
            "context": context or {},
        })

    # ------------------------------------------------------------------
    # Internal methods
    # ------------------------------------------------------------------

    def _select_agent(
        self, capability: str, force_agent_id: Optional[str] = None
    ) -> Optional[_AgentRuntime]:
        """Select the best available agent for a capability."""
        if force_agent_id:
            return self._agents.get(force_agent_id)

        candidates = []
        for rt in self._agents.values():
            if rt.state in (AgentState.STOPPED, AgentState.ERROR):
                continue
            if rt.state == AgentState.RUNNING:
                continue
            if capability in rt.definition.capabilities or capability == rt.definition.role:
                candidates.append(rt)

        if not candidates:
            # Fallback: any idle agent
            candidates = [
                rt for rt in self._agents.values()
                if rt.state == AgentState.IDLE
            ]

        if not candidates:
            return None

        # Prefer agents with fewer errors and more completions
        candidates.sort(key=lambda rt: (rt.consecutive_errors, -rt.tasks_completed))
        return candidates[0]

    async def _execute_agent_task(
        self,
        definition: AgentDefinition,
        prompt: str,
        context: Dict[str, Any],
    ) -> str:
        """Execute a task using the agent's configuration and the inference function."""
        if not self._inference_fn:
            return f"[MAS] Agent {definition.name} has no inference function configured"

        # Build system prompt with context
        system = definition.system_prompt
        if context:
            ctx_str = "\n".join(f"- {k}: {v}" for k, v in context.items() if v)
            if ctx_str:
                system = f"{system}\n\nКонтекст:\n{ctx_str}"

        # Select model via ModelSelector if available
        model = ""
        if self._model_selector:
            model, _reason = self._model_selector.select(prompt, definition.role)

        return await asyncio.wait_for(
            self._inference_fn(
                prompt=prompt,
                system_prompt=system,
                model=model,
                model_tier=definition.model_tier,
                role_name=definition.role,
            ),
            timeout=definition.timeout_sec,
        )

    def _health_check(self) -> None:
        """Reset agents that have been in error state for too long."""
        now = time.time()
        for rt in self._agents.values():
            if rt.state == AgentState.ERROR:
                if now - rt.last_active > 300:  # 5 min cooldown
                    logger.info("Recovering agent from error state", agent=rt.definition.name)
                    rt.state = AgentState.IDLE
                    rt.consecutive_errors = 0

    # ------------------------------------------------------------------
    # Status / monitoring
    # ------------------------------------------------------------------

    def get_status(self) -> Dict[str, Any]:
        """Get orchestrator status for monitoring."""
        return {
            "agents": self.list_agents(),
            "queue_size": self._task_queue.qsize(),
            "autonomous_running": self._autonomous_running,
            "total_results": len(self._results),
        }

    def get_task_result(self, task_id: str) -> Optional[TaskResult]:
        """Retrieve a previous task result by ID."""
        return self._results.get(task_id)
