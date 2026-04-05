"""Pipeline chain selector — static and dynamic chain selection.

Extracted from _core.py for modularity.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

import structlog

logger = structlog.get_logger(__name__)


def get_chain_static(
    brigade: str,
    config: Dict[str, Any],
    default_chains: Dict[str, List[str]],
) -> List[str]:
    """Return the static chain for *brigade* from config or defaults.

    Checks config["brigades"][brigade]["pipeline"] first; falls back
    to intersecting default chain with available roles.
    """
    brigade_config = config.get("brigades", {}).get(brigade, {})
    if "pipeline" in brigade_config:
        return brigade_config["pipeline"]
    available_roles = set(brigade_config.get("roles", {}).keys())
    default_chain = default_chains.get(brigade, ["Planner"])
    return [role for role in default_chain if role in available_roles]


async def get_chain_dynamic(
    prompt: str,
    brigade: str,
    config: Dict[str, Any],
    default_chains: Dict[str, List[str]],
    aflow,
    prorl,
    max_steps: int = 7,
) -> Tuple[List[str], str]:
    """Generate optimal chain via AFlow + ProRL, falling back to static.

    Returns ``(chain, source)`` where *source* is one of
    ``"config" | "heuristic" | "llm" | "lats" | "static" | "fallback"``.
    """
    from src.pipeline._lats_search import classify_complexity

    brigade_config = config.get("brigades", {}).get(brigade, {})
    if "pipeline" in brigade_config:
        return brigade_config["pipeline"][:max_steps], "config"

    available_roles = list(brigade_config.get("roles", {}).keys())
    static_chain = get_chain_static(brigade, config, default_chains)

    if not available_roles:
        return static_chain[:max_steps], "fallback"

    try:
        aflow_result = await aflow.generate_chain(
            prompt=prompt,
            brigade=brigade,
            available_roles=available_roles,
            config=config,
            max_chain_len=max_steps,
        )
        chain = aflow_result.chain or static_chain

        # ProRL — evaluate AFlow chain vs static fallback
        _complexity = classify_complexity(prompt)
        try:
            prorl_result = prorl.evaluate_candidates(
                candidates=[
                    (chain[:max_steps], aflow_result.source),
                    (static_chain[:max_steps], "static"),
                ],
                complexity=_complexity,
            )
            logger.info(
                "ProRL: chain selected",
                chain=prorl_result.selected_chain,
                source=prorl_result.selected_source,
                score=prorl_result.best_score,
            )
            return prorl_result.selected_chain, prorl_result.selected_source
        except Exception as _prorl_err:
            logger.debug("ProRL evaluation failed (non-fatal)", error=str(_prorl_err))

        logger.info(
            "AFlow chain generated",
            chain=chain,
            source=aflow_result.source,
            confidence=round(aflow_result.confidence, 2),
        )
        return chain[:max_steps], aflow_result.source
    except Exception as e:
        logger.warning("AFlow chain generation failed, using static chain", error=str(e))
        return static_chain[:max_steps], "fallback"
