"""Ensemble Voting — parallel Executor instances with consensus.

Extracted from _core.py for modularity.
"""

from __future__ import annotations

import asyncio
import re
from typing import Any, Dict, List, Optional

import structlog

logger = structlog.get_logger(__name__)


async def ensemble_vote(
    *,
    role_name: str,
    model: str,
    system_prompt: str,
    step_prompt: str,
    role_config: Dict[str, Any],
    call_llm_fn,
    active_mcp: Any,
    n_instances: int = 2,
    auditor_role_config: Optional[Dict[str, Any]] = None,
    counterfactual: Any = None,
) -> str:
    """Run N Executor instances in parallel with temperature diversity,
    then select the best response via Auditor consensus scoring.

    Uses asyncio.TaskGroup for parallel inference with graceful fallback.
    - Instance 0: temperature=0.7 (balanced)
    - Instance 1: temperature=1.0 (creative)
    - Instance 2: temperature=0.5 (conservative)
    """
    temperatures = [0.7, 1.0, 0.5][:n_instances]

    async def _run_at_temp(temp: float) -> str:
        patched_config = dict(role_config)
        patched_config["temperature"] = temp
        try:
            return await call_llm_fn(
                model=model,
                system_prompt=system_prompt,
                user_prompt=step_prompt,
                role_name=role_name,
                role_config=patched_config,
                mcp_client=active_mcp,
                preserve_think=False,
            )
        except Exception as e:
            logger.warning("Ensemble instance failed", temp=temp, error=str(e))
            return ""

    # Launch all instances concurrently
    candidates: List[str] = []
    try:
        async with asyncio.TaskGroup() as tg:
            futures = [tg.create_task(_run_at_temp(t)) for t in temperatures]
        candidates = [f.result() for f in futures if f.result()]
    except* Exception as eg:
        logger.warning("Ensemble TaskGroup error", errors=str(eg))
        # Graceful fallback via gather
        tasks = [_run_at_temp(t) for t in temperatures]
        raw = await asyncio.gather(*tasks, return_exceptions=True)
        candidates = [r for r in raw if isinstance(r, str) and r]

    if not candidates:
        logger.warning("Ensemble: all instances failed, single fallback")
        return await call_llm_fn(
            model=model,
            system_prompt=system_prompt,
            user_prompt=step_prompt,
            role_name=role_name,
            role_config=role_config,
            mcp_client=active_mcp,
        )

    if len(candidates) == 1:
        return candidates[0]

    # Auditor consensus scoring
    auditor_cfg = auditor_role_config or {}
    auditor_model = auditor_cfg.get("model") or auditor_cfg.get("openrouter_model") or model

    candidates_block = "\n\n".join(
        f"[CANDIDATE {i + 1}]:\n{c[:1500]}" for i, c in enumerate(candidates)
    )
    vote_prompt = (
        f"You are an expert judge. The following are {len(candidates)} candidate responses "
        f"to the same task. Analyse each, then either:\n"
        f"a) Select the best candidate verbatim (output: 'WINNER: <N>'), or\n"
        f"b) Synthesise a superior composite answer using the best parts.\n\n"
        f"TASK:\n{step_prompt[:600]}\n\n"
        f"{candidates_block}\n\nYour verdict (winner or composite):"
    )
    vote_system = (
        "You are a senior technical reviewer. Evaluate response quality, correctness, "
        "completeness and absence of hallucinations. Output the best answer directly."
    )

    try:
        verdict = await call_llm_fn(
            model=auditor_model,
            system_prompt=vote_system,
            user_prompt=vote_prompt,
            role_name="Ensemble_Auditor",
            role_config=auditor_cfg or role_config,
            mcp_client=active_mcp,
        )
        m = re.search(r'WINNER:\s*(\d+)', verdict or "")
        if m:
            idx = int(m.group(1)) - 1
            if 0 <= idx < len(candidates):
                logger.info("Ensemble: Auditor selected winner", idx=idx + 1)
                if counterfactual:
                    try:
                        counterfactual.record_vote(
                            role=role_name, temperatures=temperatures,
                            candidates=candidates, winner_index=idx,
                        )
                    except Exception:
                        pass
                return candidates[idx]
        if verdict and len(verdict.strip()) > 30:
            logger.info("Ensemble: Auditor synthesised composite answer")
            if counterfactual:
                try:
                    counterfactual.record_vote(
                        role=role_name, temperatures=temperatures,
                        candidates=candidates, winner_index=0,
                    )
                except Exception:
                    pass
            return verdict
    except Exception as e:
        logger.warning("Ensemble Auditor failed, using longest candidate", error=str(e))

    return max(candidates, key=len)
