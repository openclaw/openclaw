"""Mixture-of-Agents — multi-perspective generation with aggregation.

Generations run sequential to ensure quality (3 proposals + 1
aggregation per request).  Use only for high-stakes tasks where
quality is more important than latency.

Reference: Wang et al., "Mixture-of-Agents Enhances Large Language
Model Capabilities", arXiv:2406.04692.
"""

import time
from typing import List, Optional

from src.llm_gateway import route_llm

from src.ai.agents._shared import (
    MoAResult,
    logger,
)


class MixtureOfAgents:
    """Combines multiple agent perspectives for higher-quality output.

    Layer 1 — *Proposers*: generate diverse candidate responses.
    Layer 2 — *Aggregator*: synthesises the best parts into one answer.
    """

    _DEFAULT_PROPOSER_PROMPTS = [
        "You are an analytical expert. Provide a precise, fact-based answer.",
        "You are a creative problem-solver. Think outside the box and offer novel insights.",
        "You are a critical reviewer. Consider edge cases, risks, and limitations.",
    ]

    def __init__(
        self,
        model: str = "",
        num_proposers: int = 3,
    ):
        self.model = model
        self.num_proposers = num_proposers

    async def generate(
        self,
        prompt: str,
        system_prompts: Optional[List[str]] = None,
    ) -> MoAResult:
        prompts = self._resolve_system_prompts(system_prompts)
        start = time.monotonic()

        # Layer 1 — sequential to ensure quality
        proposals: List[str] = []
        for idx, sys_prompt in enumerate(prompts):
            logger.info("moa_proposer", proposer=idx + 1, total=len(prompts))
            proposal = await route_llm(
                "",
                messages=[
                    {"role": "system", "content": sys_prompt},
                    {"role": "user", "content": prompt},
                ],
                model=self.model,
                temperature=0.5 + idx * 0.1,
            )
            proposals.append(proposal)

        # Layer 2 — Aggregator
        aggregated = await self._aggregate(prompt, proposals)
        return MoAResult(
            aggregated_response=aggregated,
            proposals=proposals,
            num_proposers=len(prompts),
            elapsed_sec=time.monotonic() - start,
        )

    def _resolve_system_prompts(self, custom: Optional[List[str]]) -> List[str]:
        if custom and len(custom) >= self.num_proposers:
            return custom[: self.num_proposers]
        base = custom or self._DEFAULT_PROPOSER_PROMPTS
        return [base[i % len(base)] for i in range(self.num_proposers)]

    async def _aggregate(self, original_prompt: str, proposals: List[str]) -> str:
        numbered = "\n\n".join(
            f"--- Proposal {i + 1} ---\n{p}" for i, p in enumerate(proposals)
        )
        agg_prompt = (
            "You are an expert aggregator. Below are several candidate responses "
            "to the same question. Synthesise the best parts of each into a single, "
            "coherent, accurate answer. Preserve important details; remove redundancy.\n\n"
            f"Original question: {original_prompt}\n\n"
            f"{numbered}\n\n"
            "Synthesised answer:"
        )
        return await route_llm(
            "",
            messages=[
                {"role": "system", "content": "You synthesise multiple expert responses into one best answer."},
                {"role": "user", "content": agg_prompt},
            ],
            model=self.model,
            temperature=0.2,
        )
