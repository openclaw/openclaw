"""Pipeline package — decomposed from pipeline_executor.py."""

from src.pipeline._core import PipelineExecutor
from src.pipeline._state import rag_necessary
from src.pipeline._lats_search import LATSEngine, LATSResult, classify_complexity
from src.pipeline._sage import SAGEEngine, SAGECorrectionResult
from src.safety.mac_constitution import MACConstitution, MACState, ConstitutionRule
from src.pipeline._counterfactual import CounterfactualCredit, CandidateCredit, CreditRecord
from src.pipeline._prorl import ProRLEngine, RolloutResult, RolloutCandidate

# Decomposed submodules (public API only)
from src.pipeline._chain_selector import get_chain_static, get_chain_dynamic
from src.pipeline._ensemble import ensemble_vote
from src.pipeline._multi_task import decompose_multi_task, route_subtask, execute_multi_task
from src.pipeline._role_executor import run_single_step, call_llm

__all__ = [
    "PipelineExecutor",
    "rag_necessary",
    "LATSEngine",
    "LATSResult",
    "classify_complexity",
    "SAGEEngine",
    "SAGECorrectionResult",
    "MACConstitution",
    "MACState",
    "ConstitutionRule",
    "CounterfactualCredit",
    "CandidateCredit",
    "CreditRecord",
    "ProRLEngine",
    "RolloutResult",
    "RolloutCandidate",
    # Decomposed submodules
    "get_chain_static",
    "get_chain_dynamic",
    "ensemble_vote",
    "decompose_multi_task",
    "route_subtask",
    "execute_multi_task",
    "run_single_step",
    "call_llm",
]
