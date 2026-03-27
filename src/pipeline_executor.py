"""
Brigade: OpenClaw
Role: Pipeline Executor (Chain-of-Agents)

Backward-compatible facade — real implementation in src/pipeline/.
All imports of ``from src.pipeline_executor import PipelineExecutor`` continue to work.
"""

from src.pipeline._core import PipelineExecutor  # noqa: F401

__all__ = ["PipelineExecutor"]
