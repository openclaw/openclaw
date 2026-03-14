"""
OpenClaw Analytics Package

A comprehensive data analysis toolkit for OpenClaw performance metrics.
"""

from .data_analyzer import (
    DataAnalyzer,
    MetricPoint,
    AnalysisResult,
    Anomaly,
    AnalysisReport,
    __version__,
    __author__,
    __email__
)

__all__ = [
    'DataAnalyzer',
    'MetricPoint',
    'AnalysisResult',
    'Anomaly',
    'AnalysisReport',
    '__version__',
    '__author__',
    '__email__'
]
