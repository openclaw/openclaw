"""MARCH — Multi-Agent Reinforced Self-Check for Hallucination Control.

Reference:
- Li et al., "MARCH: Multi-Agent Reinforced Self-Check for LLM
  Hallucination", arXiv:2603.24579v1
- Collected in data/research/v11.6/arxiv

Core mechanism: before Archivist emits a final response, key entities
are extracted and cross-verified against SuperMemory. Discrepancies
trigger an automatic Reflexion cycle.

Integrates with the existing HallucinationDetector in safety_guardrails.py
and the SuperMemory store in src/supermemory.py.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import structlog

from src.ai.agents._shared import call_vllm

logger = structlog.get_logger("MARCH")


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class EntityClaim:
    """An extracted entity or factual claim from an agent response."""
    entity: str
    claim: str
    source_agent: str
    confidence: float = 1.0


@dataclass
class VerificationResult:
    """Result of cross-verifying a single claim."""
    claim: EntityClaim
    verified: bool
    memory_evidence: str = ""
    discrepancy: str = ""


@dataclass
class MARCHResult:
    """Aggregated result of the MARCH protocol."""
    is_consistent: bool
    verified_claims: List[VerificationResult]
    discrepancies: List[VerificationResult]
    reflexion_triggered: bool = False
    corrected_response: Optional[str] = None
    elapsed_sec: float = 0.0


# ---------------------------------------------------------------------------
# Entity / claim extraction (heuristic, no LLM for speed)
# ---------------------------------------------------------------------------

# Patterns for factual claims
_FILE_PATH_RE = re.compile(r"(?:`([^`]+\.\w{1,6})`|(\S+\.\w{1,6})(?:\s|$))")
_FUNCTION_RE = re.compile(r"`(\w+)\(\)`|(?:function|def|fn|func)\s+(\w+)")
_VERSION_RE = re.compile(r"v?\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?")
_NUMBER_CLAIM_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:%|процент|раз|times|tokens|ms|сек|sec)")
_URL_RE = re.compile(r"https?://\S+")


def extract_entities(text: str, source_agent: str = "unknown") -> List[EntityClaim]:
    """Extract verifiable entities and claims from agent output."""
    claims: List[EntityClaim] = []

    # File paths
    for m in _FILE_PATH_RE.finditer(text):
        path = m.group(1) or m.group(2)
        if path and len(path) > 3:
            claims.append(EntityClaim(
                entity=path,
                claim=f"References file: {path}",
                source_agent=source_agent,
            ))

    # Function names
    for m in _FUNCTION_RE.finditer(text):
        name = m.group(1) or m.group(2)
        if name and len(name) > 2:
            claims.append(EntityClaim(
                entity=name,
                claim=f"References function: {name}",
                source_agent=source_agent,
            ))

    # Version numbers
    for m in _VERSION_RE.finditer(text):
        claims.append(EntityClaim(
            entity=m.group(),
            claim=f"Mentions version: {m.group()}",
            source_agent=source_agent,
            confidence=0.8,
        ))

    # Numeric claims
    for m in _NUMBER_CLAIM_RE.finditer(text):
        ctx_start = max(0, m.start() - 40)
        ctx = text[ctx_start:m.end()]
        claims.append(EntityClaim(
            entity=m.group(),
            claim=f"Numeric claim: {ctx.strip()}",
            source_agent=source_agent,
            confidence=0.7,
        ))

    return claims


# ---------------------------------------------------------------------------
# MARCH Protocol Engine
# ---------------------------------------------------------------------------

class MARCHProtocol:
    """Cross-verification protocol between agents.

    Usage in the pipeline:
        march = MARCHProtocol(supermemory=mem, vllm_url=url, model=model)
        result = await march.cross_verify_agents(
            executor_response="...",
            archivist_response="...",
        )
        if not result.is_consistent:
            # trigger Reflexion cycle
    """

    _DISCREPANCY_THRESHOLD = 0.5  # fraction of unverified claims to trigger

    def __init__(
        self,
        supermemory: Any = None,
        vllm_url: str = "",
        model: str = "",
    ):
        self.supermemory = supermemory
        self.vllm_url = vllm_url.rstrip("/") if vllm_url else ""
        self.model = model

    async def cross_verify_agents(
        self,
        executor_response: str,
        archivist_response: str = "",
        prompt: str = "",
        **kwargs: Any,
    ) -> MARCHResult:
        """Run the MARCH cross-verification protocol.

        1. Extract entities from executor and archivist responses.
        2. Verify each against SuperMemory knowledge base.
        3. If discrepancy rate exceeds threshold — trigger Reflexion.

        v14.4: Accepts **kwargs so callers can pass extra context
        (memory, config, etc.) without causing TypeError.
        """
        # v14.4: Accept supermemory override from pipeline caller
        if "memory" in kwargs and kwargs["memory"] is not None:
            self.supermemory = kwargs["memory"]

        start = time.monotonic()

        # Step 1: Extract claims
        executor_claims = extract_entities(executor_response, "Executor")
        archivist_claims = extract_entities(archivist_response, "Archivist") if archivist_response else []
        all_claims = executor_claims + archivist_claims

        if not all_claims:
            return MARCHResult(
                is_consistent=True,
                verified_claims=[],
                discrepancies=[],
                elapsed_sec=round(time.monotonic() - start, 2),
            )

        # Step 2: Verify against SuperMemory
        verified: List[VerificationResult] = []
        discrepancies: List[VerificationResult] = []

        for claim in all_claims:
            vr = await self._verify_claim(claim)
            if vr.verified:
                verified.append(vr)
            else:
                discrepancies.append(vr)

        # Cross-check: look for contradictions between executor and archivist
        cross_disc = self._cross_check_agents(executor_claims, archivist_claims)
        discrepancies.extend(cross_disc)

        total = len(all_claims) + len(cross_disc)
        disc_rate = len(discrepancies) / total if total > 0 else 0.0
        is_consistent = disc_rate < self._DISCREPANCY_THRESHOLD

        result = MARCHResult(
            is_consistent=is_consistent,
            verified_claims=verified,
            discrepancies=discrepancies,
            elapsed_sec=round(time.monotonic() - start, 2),
        )

        # Step 3: Reflexion cycle if needed
        if not is_consistent and self.vllm_url and prompt:
            logger.warning(
                "march_discrepancy_detected",
                disc_rate=round(disc_rate, 2),
                discrepancy_count=len(discrepancies),
            )
            corrected = await self._reflexion_correct(
                prompt, executor_response, discrepancies,
            )
            if corrected:
                result.reflexion_triggered = True
                result.corrected_response = corrected

        return result

    # ------------------------------------------------------------------
    # Private: verify a single claim against SuperMemory
    # ------------------------------------------------------------------

    async def _verify_claim(self, claim: EntityClaim) -> VerificationResult:
        """Check a claim against SuperMemory. Returns verified/not."""
        if not self.supermemory:
            # No memory available — assume unverifiable, low confidence
            return VerificationResult(
                claim=claim,
                verified=claim.confidence >= 0.9,  # high-confidence claims pass
                memory_evidence="[no SuperMemory available]",
            )

        try:
            results = self.supermemory.recall(claim.entity, top_k=2)
            if not results:
                return VerificationResult(
                    claim=claim,
                    verified=False,
                    memory_evidence="[no matching memory found]",
                    discrepancy=f"Entity '{claim.entity}' not found in knowledge base",
                )

            # Check if the recalled content supports or contradicts
            top_result = results[0]
            evidence_text = top_result.content if hasattr(top_result, "content") else str(top_result)

            # Simple overlap heuristic
            entity_lower = claim.entity.lower()
            evidence_lower = evidence_text.lower()

            if entity_lower in evidence_lower:
                return VerificationResult(
                    claim=claim,
                    verified=True,
                    memory_evidence=evidence_text[:200],
                )
            else:
                return VerificationResult(
                    claim=claim,
                    verified=False,
                    memory_evidence=evidence_text[:200],
                    discrepancy=f"Entity '{claim.entity}' not confirmed by memory evidence",
                )
        except Exception as e:
            logger.debug("march_verify_error", entity=claim.entity, error=str(e))
            return VerificationResult(
                claim=claim,
                verified=True,  # err on the side of trust
                memory_evidence=f"[verification error: {e}]",
            )

    # ------------------------------------------------------------------
    # Private: cross-check between two agents
    # ------------------------------------------------------------------

    @staticmethod
    def _cross_check_agents(
        exec_claims: List[EntityClaim],
        arch_claims: List[EntityClaim],
    ) -> List[VerificationResult]:
        """Detect contradictions between executor and archivist claims."""
        disc: List[VerificationResult] = []
        exec_entities = {c.entity.lower(): c for c in exec_claims}
        arch_entities = {c.entity.lower(): c for c in arch_claims}

        # Find shared entities with different claims
        shared_keys = set(exec_entities.keys()) & set(arch_entities.keys())
        for key in shared_keys:
            ec = exec_entities[key]
            ac = arch_entities[key]
            if ec.claim != ac.claim:
                disc.append(VerificationResult(
                    claim=ec,
                    verified=False,
                    memory_evidence=f"Archivist says: {ac.claim}",
                    discrepancy=f"Contradicting claims: Executor='{ec.claim}' vs Archivist='{ac.claim}'",
                ))

        return disc

    # ------------------------------------------------------------------
    # Private: Reflexion correction on discrepancy
    # ------------------------------------------------------------------

    async def _reflexion_correct(
        self,
        prompt: str,
        original_response: str,
        discrepancies: List[VerificationResult],
    ) -> Optional[str]:
        """Use LLM to correct the response based on identified discrepancies."""
        if not self.vllm_url:
            return None

        disc_text = "\n".join(
            f"- {d.discrepancy}" for d in discrepancies[:5] if d.discrepancy
        )

        correction_prompt = (
            f"Original task: {prompt[:500]}\n\n"
            f"Response to correct:\n{original_response[:1000]}\n\n"
            f"The following factual discrepancies were detected by cross-verification:\n"
            f"{disc_text}\n\n"
            f"Produce a corrected response that addresses these discrepancies. "
            f"If you cannot verify a claim, explicitly state uncertainty."
        )

        try:
            corrected = await call_vllm(
                self.vllm_url,
                self.model,
                [
                    {"role": "system", "content": "You are a fact-checking agent. Correct factual errors."},
                    {"role": "user", "content": correction_prompt},
                ],
                temperature=0.2,
                max_tokens=2048,
            )
            logger.info("march_reflexion_complete", corrected_len=len(corrected))
            return corrected.strip() if corrected.strip() else None
        except Exception as e:
            logger.warning("march_reflexion_failed", error=str(e))
            return None
