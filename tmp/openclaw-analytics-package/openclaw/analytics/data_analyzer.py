#!/usr/bin/env python3
"""
OpenClaw Performance Data Analyzer

A comprehensive data analysis toolkit for OpenClaw performance metrics.

Features:
- Load and parse performance data from multiple sources
- Statistical analysis (mean, median, p95, p99, std deviation)
- Trend detection and anomaly detection
- Multi-format report generation (text, JSON, HTML, Markdown)
- Data visualization support
- Integration with OpenClaw Performance Monitor

Usage:
    python -m openclaw.analytics.data_analyzer --input metrics.json --output report.html
    
Example:
    from openclaw.analytics.data_analyzer import DataAnalyzer
    
    analyzer = DataAnalyzer()
    analyzer.load_from_json('metrics.json')
    results = analyzer.analyze()
    report = analyzer.generate_report(format='html')
"""

import json
import statistics
import csv
import os
import sys
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional, Tuple, Union
from dataclasses import dataclass, field, asdict
from collections import defaultdict
import math


__version__ = "1.0.0"
__author__ = "OpenClaw Team"
__email__ = "team@openclaw.ai"


@dataclass
class MetricPoint:
    """Single metric data point"""
    timestamp: float
    cpu_usage: float = 0.0
    memory_used: float = 0.0
    memory_total: float = 0.0
    agent_executions: int = 0
    model_requests: int = 0
    ws_latency: float = 0.0
    error_count: int = 0
    
    @property
    def memory_percent(self) -> float:
        """Calculate memory usage percentage"""
        return (self.memory_used / self.memory_total * 100) if self.memory_total > 0 else 0.0


@dataclass
class AnalysisResult:
    """Analysis result for a metric series"""
    name: str
    count: int = 0
    mean: float = 0.0
    median: float = 0.0
    std_dev: float = 0.0
    min_val: float = 0.0
    max_val: float = 0.0
    p95: float = 0.0
    p99: float = 0.0
    trend: str = 'stable'  # 'increasing', 'decreasing', 'stable', 'unknown'
    slope: float = 0.0
    last_value: float = 0.0
    first_value: float = 0.0
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary"""
        return {
            'name': self.name,
            'count': self.count,
            'mean': round(self.mean, 4),
            'median': round(self.median, 4),
            'std_dev': round(self.std_dev, 4),
            'min': round(self.min_val, 4),
            'max': round(self.max_val, 4),
            'p95': round(self.p95, 4),
            'p99': round(self.p99, 4),
            'trend': self.trend,
            'slope': round(self.slope, 6),
            'last_value': round(self.last_value, 4),
            'first_value': round(self.first_value, 4)
        }


@dataclass
class Anomaly:
    """Detected anomaly"""
    timestamp: float
    metric: str
    value: float
    expected: float
    deviation: float
    z_score: float
    severity: str  # 'low', 'medium', 'high', 'critical'
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary"""
        return {
            'timestamp': self.timestamp,
            'datetime': datetime.fromtimestamp(self.timestamp).isoformat(),
            'metric': self.metric,
            'value': round(self.value, 4),
            'expected': round(self.expected, 4),
            'deviation': round(self.deviation, 4),
            'z_score': round(self.z_score, 4),
            'severity': self.severity
        }


@dataclass
class AnalysisReport:
    """Complete analysis report"""
    generated_at: str
    summary: Dict[str, Any]
    metrics: Dict[str, AnalysisResult]
    anomalies: List[Anomaly]
    recommendations: List[str]
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary"""
        return {
            'generated_at': self.generated_at,
            'summary': self.summary,
            'metrics': {k: v.to_dict() for k, v in self.metrics.items()},
            'anomalies': [a.to_dict() for a in self.anomalies],
            'recommendations': self.recommendations
        }


class DataAnalyzer:
    """
    Main data analysis class for OpenClaw performance metrics
    
    Examples:
        >>> analyzer = DataAnalyzer()
        >>> analyzer.load_from_json('metrics.json')
        >>> results = analyzer.analyze()
        >>> report = analyzer.generate_report(format='html')
    """
    
    def __init__(self, config: Optional[Dict[str, Any]] = None):
        """
        Initialize analyzer
        
        Args:
            config: Configuration options
                - anomaly_threshold: Z-score threshold for anomaly detection (default: 2.5)
                - trend_threshold: Percentage change for trend detection (default: 10%)
                - min_data_points: Minimum data points for analysis (default: 3)
        """
        self.config = config or {}
        self.data_points: List[MetricPoint] = []
        self.analysis_cache: Dict[str, AnalysisResult] = {}
        self.anomaly_cache: List[Anomaly] = []
        
        # Configuration
        self.anomaly_threshold = self.config.get('anomaly_threshold', 2.5)
        self.trend_threshold = self.config.get('trend_threshold', 10)
        self.min_data_points = self.config.get('min_data_points', 3)
    
    def load_from_json(self, filepath: str) -> int:
        """
        Load metrics from JSON file
        
        Args:
            filepath: Path to JSON file
            
        Returns:
            Number of data points loaded
        """
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        # Handle different JSON structures
        if isinstance(data, list):
            metrics_list = data
        elif isinstance(data, dict):
            if 'metrics' in data:
                # Handle both list and single object formats
                # FIX: Support OpenClaw monitor exporter format
                metrics_data = data['metrics']
                if isinstance(metrics_data, list):
                    metrics_list = metrics_data
                elif isinstance(metrics_data, dict):
                    # Single metrics object from monitor exporter
                    metrics_list = [metrics_data]
                else:
                    raise ValueError("Invalid 'metrics' format in JSON")
            elif 'data_points' in data:
                metrics_list = data['data_points']
            else:
                metrics_list = [data]
        else:
            raise ValueError("Invalid JSON structure")
        
        count = 0
        for item in metrics_list:
            point = self._parse_metric_point(item)
            if point:
                self.data_points.append(point)
                count += 1
        
        return count
    
    def load_from_csv(self, filepath: str) -> int:
        """
        Load metrics from CSV file
        
        Args:
            filepath: Path to CSV file
            
        Returns:
            Number of data points loaded
        """
        count = 0
        with open(filepath, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                point = self._parse_csv_row(row)
                if point:
                    self.data_points.append(point)
                    count += 1
        
        return count
    
    def add_metric_point(self, point: MetricPoint) -> None:
        """Add a single metric point"""
        self.data_points.append(point)
    
    def analyze(self, force: bool = False) -> Dict[str, AnalysisResult]:
        """
        Perform comprehensive analysis on loaded data
        
        Args:
            force: Force re-analysis even if cache exists
            
        Returns:
            Dictionary of analysis results by metric name
        """
        if not self.data_points:
            return {}
        
        if self.analysis_cache and not force:
            return self.analysis_cache
        
        results = {}
        
        # Sort by timestamp
        sorted_points = sorted(self.data_points, key=lambda p: p.timestamp)
        
        # CPU Analysis
        cpu_values = [(p.timestamp, p.cpu_usage) for p in sorted_points]
        if cpu_values:
            results['cpu_usage'] = self._analyze_time_series('CPU Usage (%)', cpu_values)
        
        # Memory Analysis
        memory_values = [(p.timestamp, p.memory_percent) for p in sorted_points]
        if any(v[1] > 0 for v in memory_values):
            results['memory_usage'] = self._analyze_time_series('Memory Usage (%)', memory_values)
        
        # WebSocket Latency Analysis
        latency_values = [(p.timestamp, p.ws_latency) for p in sorted_points if p.ws_latency > 0]
        if latency_values:
            results['ws_latency'] = self._analyze_time_series('WebSocket Latency (ms)', latency_values)
        
        # Throughput Analysis
        throughput = self._calculate_throughput(sorted_points)
        if throughput:
            results['throughput'] = self._analyze_time_series('Requests/min', throughput)
        
        # Error Rate Analysis
        error_rates = self._calculate_error_rates(sorted_points)
        if error_rates:
            results['error_rate'] = self._analyze_time_series('Error Rate (%)', error_rates)
        
        self.analysis_cache = results
        return results
    
    def detect_anomalies(self, threshold: Optional[float] = None) -> List[Anomaly]:
        """
        Detect anomalies using Z-score method
        
        Args:
            threshold: Z-score threshold (default: from config)
            
        Returns:
            List of detected anomalies
        """
        if not self.analysis_cache:
            self.analyze()
        
        threshold = threshold or self.anomaly_threshold
        anomalies = []
        
        for metric_name, result in self.analysis_cache.items():
            if result.std_dev == 0:
                continue
            
            # Get time series data
            if metric_name == 'cpu_usage':
                values = [(p.timestamp, p.cpu_usage) for p in self.data_points]
            elif metric_name == 'memory_usage':
                values = [(p.timestamp, p.memory_percent) for p in self.data_points]
            elif metric_name == 'ws_latency':
                values = [(p.timestamp, p.ws_latency) for p in self.data_points if p.ws_latency > 0]
            elif metric_name == 'error_rate':
                error_rates = self._calculate_error_rates(sorted(self.data_points, key=lambda p: p.timestamp))
                values = error_rates
            else:
                continue
            
            # Find anomalies
            for timestamp, value in values:
                z_score = abs(value - result.mean) / result.std_dev if result.std_dev > 0 else 0
                
                if z_score > threshold:
                    severity = self._get_severity(z_score)
                    anomalies.append(Anomaly(
                        timestamp=timestamp,
                        metric=metric_name,
                        value=value,
                        expected=result.mean,
                        deviation=abs(value - result.mean),
                        z_score=z_score,
                        severity=severity
                    ))
        
        # Sort by severity and z-score
        anomalies.sort(key=lambda a: (-{'critical': 4, 'high': 3, 'medium': 2, 'low': 1}[a.severity], -a.z_score))
        
        self.anomaly_cache = anomalies
        return anomalies
    
    def generate_recommendations(self) -> List[str]:
        """Generate actionable recommendations based on analysis"""
        if not self.analysis_cache:
            self.analyze()
        
        recommendations = []
        
        for metric_name, result in self.analysis_cache.items():
            # CPU recommendations
            if metric_name == 'cpu_usage':
                if result.mean > 80:
                    recommendations.append(
                        f"⚠️ High CPU usage detected (avg: {result.mean:.1f}%). "
                        "Consider optimizing compute-intensive operations or scaling resources."
                    )
                if result.trend == 'increasing':
                    recommendations.append(
                        f"📈 CPU usage trend is increasing. Monitor closely and plan for capacity scaling."
                    )
            
            # Memory recommendations
            elif metric_name == 'memory_usage':
                if result.mean > 85:
                    recommendations.append(
                        f"⚠️ High memory usage detected (avg: {result.mean:.1f}%). "
                        "Check for memory leaks and consider increasing heap size."
                    )
                if result.p99 > 95:
                    recommendations.append(
                        f"🔴 Memory usage peaked at {result.max_val:.1f}%. "
                        "Critical: Risk of OOM errors. Increase memory limits immediately."
                    )
            
            # Latency recommendations
            elif metric_name == 'ws_latency':
                if result.p95 > 1000:
                    recommendations.append(
                        f"⚠️ High WebSocket latency detected (P95: {result.p95:.0f}ms). "
                        "Check network connectivity and optimize message processing."
                    )
                if result.trend == 'increasing':
                    recommendations.append(
                        f"📈 WebSocket latency is increasing. Investigate potential bottlenecks."
                    )
            
            # Error rate recommendations
            elif metric_name == 'error_rate':
                if result.mean > 5:
                    recommendations.append(
                        f"⚠️ High error rate detected (avg: {result.mean:.2f}%). "
                        "Review error logs and implement error handling improvements."
                    )
                if result.max_val > 20:
                    recommendations.append(
                        f"🔴 Error rate peaked at {result.max_val:.2f}%. "
                        "Critical: Investigate and fix recurring errors."
                    )
        
        # Check for anomalies
        anomalies = self.detect_anomalies()
        if len(anomalies) > 10:
            recommendations.append(
                f"🔴 {len(anomalies)} anomalies detected. "
                "System behavior is highly irregular. Recommend immediate investigation."
            )
        
        return recommendations
    
    def generate_report(
        self, 
        format: str = 'text',
        output_file: Optional[str] = None
    ) -> str:
        """
        Generate analysis report in specified format
        
        Args:
            format: Output format ('text', 'json', 'html', 'markdown')
            output_file: Optional file path to save report
            
        Returns:
            Report content as string
        """
        if not self.analysis_cache:
            self.analyze()
        
        generators = {
            'text': self._generate_text_report,
            'json': self._generate_json_report,
            'html': self._generate_html_report,
            'markdown': self._generate_markdown_report
        }
        
        if format not in generators:
            raise ValueError(f"Unsupported format: {format}. Use: {list(generators.keys())}")
        
        report = generators[format]()
        
        if output_file:
            with open(output_file, 'w', encoding='utf-8') as f:
                f.write(report)
        
        return report
    
    def get_summary_stats(self) -> Dict[str, Any]:
        """Get summary statistics"""
        if not self.data_points:
            return {}
        
        sorted_points = sorted(self.data_points, key=lambda p: p.timestamp)
        
        total_agents = sum(p.agent_executions for p in sorted_points)
        total_models = sum(p.model_requests for p in sorted_points)
        total_errors = sum(p.error_count for p in sorted_points)
        
        duration = sorted_points[-1].timestamp - sorted_points[0].timestamp
        
        return {
            'total_data_points': len(sorted_points),
            'time_range': {
                'start': datetime.fromtimestamp(sorted_points[0].timestamp).isoformat(),
                'end': datetime.fromtimestamp(sorted_points[-1].timestamp).isoformat(),
                'duration_seconds': duration,
                'duration_human': str(timedelta(seconds=int(duration)))
            },
            'operations': {
                'total_agent_executions': total_agents,
                'total_model_requests': total_models,
                'total_operations': total_agents + total_models,
                'total_errors': total_errors,
                'overall_error_rate': (total_errors / (total_agents + total_models) * 100) if (total_agents + total_models) > 0 else 0
            }
        }
    
    def export_analysis(self, filepath: str, format: str = 'json') -> None:
        """Export analysis to file"""
        if not self.analysis_cache:
            self.analyze()
        
        if format == 'json':
            report = AnalysisReport(
                generated_at=datetime.now().isoformat(),
                summary=self.get_summary_stats(),
                metrics=self.analysis_cache,
                anomalies=self.detect_anomalies(),
                recommendations=self.generate_recommendations()
            )
            with open(filepath, 'w', encoding='utf-8') as f:
                json.dump(report.to_dict(), f, indent=2)
        
        elif format == 'csv':
            with open(filepath, 'w', newline='', encoding='utf-8') as f:
                writer = csv.writer(f)
                writer.writerow([
                    'metric', 'count', 'mean', 'median', 'std_dev', 
                    'min', 'max', 'p95', 'p99', 'trend'
                ])
                for name, result in self.analysis_cache.items():
                    writer.writerow([
                        result.name, result.count, 
                        round(result.mean, 4), round(result.median, 4),
                        round(result.std_dev, 4), round(result.min_val, 4),
                        round(result.max_val, 4), round(result.p95, 4),
                        round(result.p99, 4), result.trend
                    ])
    
    def clear(self) -> None:
        """Clear all cached data"""
        self.data_points.clear()
        self.analysis_cache.clear()
        self.anomaly_cache.clear()
    
    # Private methods
    
    def _parse_metric_point(self, data: Dict[str, Any]) -> Optional[MetricPoint]:
        """Parse metric point from dictionary"""
        try:
            memory_usage = data.get('memoryUsage', {})
            
            return MetricPoint(
                timestamp=data.get('timestamp', 0),
                cpu_usage=data.get('cpuUsage', 0.0),
                memory_used=memory_usage.get('heapUsed', 0),
                memory_total=memory_usage.get('heapTotal', 0),
                agent_executions=sum(
                    a.get('executionCount', 0) for a in data.get('agentMetrics', [])
                ),
                model_requests=sum(
                    m.get('requestCount', 0) for m in data.get('modelMetrics', [])
                ),
                ws_latency=data.get('websocketMetrics', {}).get('averageLatency', 0.0),
                error_count=sum(
                    a.get('errorCount', 0) for a in data.get('agentMetrics', [])
                ) + sum(
                    m.get('errorRate', 0) * m.get('requestCount', 0) / 100 
                    for m in data.get('modelMetrics', [])
                )
            )
        except Exception as e:
            print(f"Warning: Failed to parse metric point: {e}", file=sys.stderr)
            return None
    
    def _parse_csv_row(self, row: Dict[str, str]) -> Optional[MetricPoint]:
        """Parse metric point from CSV row"""
        try:
            return MetricPoint(
                timestamp=float(row.get('timestamp', 0)),
                cpu_usage=float(row.get('cpu_usage', 0)),
                memory_used=float(row.get('memory_used', 0)),
                memory_total=float(row.get('memory_total', 1)),
                agent_executions=int(row.get('agent_executions', 0)),
                model_requests=int(row.get('model_requests', 0)),
                ws_latency=float(row.get('ws_latency', 0)),
                error_count=int(row.get('error_count', 0))
            )
        except Exception as e:
            print(f"Warning: Failed to parse CSV row: {e}", file=sys.stderr)
            return None
    
    def _analyze_time_series(
        self, 
        name: str, 
        values: List[Tuple[float, float]]
    ) -> AnalysisResult:
        """Analyze a time series"""
        if len(values) < self.min_data_points:
            return AnalysisResult(name=name, count=len(values), trend='unknown')
        
        timestamps = [v[0] for v in values]
        data = [v[1] for v in values]
        
        # Basic statistics
        sorted_data = sorted(data)
        count = len(data)
        
        # Trend detection using linear regression
        trend, slope = self._detect_trend(timestamps, data)
        
        return AnalysisResult(
            name=name,
            count=count,
            mean=statistics.mean(data),
            median=statistics.median(data),
            std_dev=statistics.stdev(data) if count > 1 else 0,
            min_val=min(data),
            max_val=max(data),
            p95=self._percentile(sorted_data, 95),
            p99=self._percentile(sorted_data, 99),
            trend=trend,
            slope=slope,
            last_value=data[-1],
            first_value=data[0]
        )
    
    def _detect_trend(
        self, 
        timestamps: List[float], 
        values: List[float]
    ) -> Tuple[str, float]:
        """Detect trend using simple linear regression"""
        if len(values) < 3:
            return 'stable', 0.0
        
        # Simple linear regression
        n = len(values)
        x_mean = sum(range(n)) / n
        y_mean = sum(values) / n
        
        numerator = sum((i - x_mean) * (values[i] - y_mean) for i in range(n))
        denominator = sum((i - x_mean) ** 2 for i in range(n))
        
        slope = numerator / denominator if denominator != 0 else 0
        
        # Determine trend direction
        first_avg = statistics.mean(values[:n//3])
        last_avg = statistics.mean(values[-n//3:])
        
        if first_avg == 0:
            return 'stable', slope
        
        change_percent = ((last_avg - first_avg) / first_avg) * 100
        
        if change_percent > self.trend_threshold:
            return 'increasing', slope
        elif change_percent < -self.trend_threshold:
            return 'decreasing', slope
        else:
            return 'stable', slope
    
    def _percentile(self, sorted_values: List[float], percentile: int) -> float:
        """Calculate percentile"""
        if not sorted_values:
            return 0.0
        
        index = (len(sorted_values) - 1) * percentile / 100
        lower = int(index)
        upper = lower + 1
        
        if upper >= len(sorted_values):
            return sorted_values[-1]
        
        weight = index - lower
        return sorted_values[lower] * (1 - weight) + sorted_values[upper] * weight
    
    def _calculate_throughput(
        self, 
        points: List[MetricPoint]
    ) -> List[Tuple[float, float]]:
        """
        Calculate requests per minute using interval deltas
        
        FIX: Uses the difference between consecutive cumulative counters to compute
        the actual requests in each interval, avoiding inflated throughput values.
        
        Previously used absolute cumulative values which showed increasing throughput
        even when actual per-interval load was constant.
        """
        if len(points) < 2:
            return []
        
        throughput = []
        for i in range(1, len(points)):
            time_diff = points[i].timestamp - points[i-1].timestamp
            if time_diff > 0:
                # Calculate delta from previous sample (cumulative counters)
                model_delta = points[i].model_requests - points[i-1].model_requests
                agent_delta = points[i].agent_executions - points[i-1].agent_executions
                
                # Handle counter reset (if negative, use current value as delta)
                if model_delta < 0:
                    model_delta = points[i].model_requests
                if agent_delta < 0:
                    agent_delta = points[i].agent_executions
                
                # Total requests in this interval
                requests_delta = model_delta + agent_delta
                
                # Convert to requests per minute
                rate = (requests_delta / time_diff) * 60
                throughput.append((points[i].timestamp, rate))
        
        return throughput
    
    def _calculate_error_rates(
        self, 
        points: List[MetricPoint]
    ) -> List[Tuple[float, float]]:
        """Calculate error rates over time"""
        rates = []
        
        for point in points:
            total = point.agent_executions + point.model_requests
            if total > 0:
                rate = (point.error_count / total) * 100
                rates.append((point.timestamp, rate))
        
        return rates
    
    def _get_severity(self, z_score: float) -> str:
        """Get anomaly severity based on z-score"""
        if z_score > 4:
            return 'critical'
        elif z_score > 3:
            return 'high'
        elif z_score > 2:
            return 'medium'
        else:
            return 'low'
    
    # Report generators
    
    def _generate_text_report(self) -> str:
        """Generate text report"""
        lines = [
            '=' * 70,
            'OpenClaw Performance Analysis Report',
            '=' * 70,
            '',
            f'Generated at: {datetime.now().isoformat()}',
            '',
            self._text_summary(),
            '',
            self._text_metrics(),
            '',
            self._text_anomalies(),
            '',
            self._text_recommendations(),
            '',
            '=' * 70
        ]
        return '\n'.join(lines)
    
    def _text_summary(self) -> str:
        """Generate text summary section"""
        stats = self.get_summary_stats()
        lines = ['--- Summary ---']
        
        lines.append(f'Total Data Points: {stats.get("total_data_points", 0)}')
        
        time_range = stats.get('time_range', {})
        if time_range:
            lines.extend([
                f'Time Range: {time_range.get("start", "N/A")} to {time_range.get("end", "N/A")}',
                f'Duration: {time_range.get("duration_human", "N/A")}'
            ])
        
        ops = stats.get('operations', {})
        if ops:
            lines.extend([
                f'Total Agent Executions: {ops.get("total_agent_executions", 0)}',
                f'Total Model Requests: {ops.get("total_model_requests", 0)}',
                f'Total Errors: {ops.get("total_errors", 0)}',
                f'Overall Error Rate: {ops.get("overall_error_rate", 0):.2f}%'
            ])
        
        return '\n'.join(lines)
    
    def _text_metrics(self) -> str:
        """Generate text metrics section"""
        lines = ['--- Metrics Analysis ---', '']
        
        for name, result in self.analysis_cache.items():
            lines.extend([
                f'{result.name}:',
                f'  Count: {result.count}',
                f'  Mean: {result.mean:.2f}',
                f'  Median: {result.median:.2f}',
                f'  Std Dev: {result.std_dev:.2f}',
                f'  Min: {result.min_val:.2f}',
                f'  Max: {result.max_val:.2f}',
                f'  P95: {result.p95:.2f}',
                f'  P99: {result.p99:.2f}',
                f'  Trend: {result.trend}',
                ''
            ])
        
        return '\n'.join(lines)
    
    def _text_anomalies(self) -> str:
        """Generate text anomalies section"""
        anomalies = self.detect_anomalies()
        
        if not anomalies:
            return '--- Anomalies ---\nNo anomalies detected.'
        
        lines = [f'--- Anomalies ({len(anomalies)} detected) ---', '']
        
        for anomaly in anomalies[:10]:
            lines.extend([
                f'[{anomaly.severity.upper()}] {anomaly.metric}',
                f'  Value: {anomaly.value:.2f}',
                f'  Expected: {anomaly.expected:.2f}',
                f'  Z-Score: {anomaly.z_score:.2f}',
                f'  Time: {datetime.fromtimestamp(anomaly.timestamp).isoformat()}',
                ''
            ])
        
        if len(anomalies) > 10:
            lines.append(f'... and {len(anomalies) - 10} more anomalies')
        
        return '\n'.join(lines)
    
    def _text_recommendations(self) -> str:
        """Generate text recommendations section"""
        recommendations = self.generate_recommendations()
        
        if not recommendations:
            return '--- Recommendations ---\nNo recommendations at this time.'
        
        lines = ['--- Recommendations ---', '']
        
        for i, rec in enumerate(recommendations, 1):
            lines.append(f'{i}. {rec}')
        
        return '\n'.join(lines)
    
    def _generate_json_report(self) -> str:
        """Generate JSON report"""
        report = AnalysisReport(
            generated_at=datetime.now().isoformat(),
            summary=self.get_summary_stats(),
            metrics=self.analysis_cache,
            anomalies=self.detect_anomalies(),
            recommendations=self.generate_recommendations()
        )
        return json.dumps(report.to_dict(), indent=2)
    
    def _generate_html_report(self) -> str:
        """Generate HTML report"""
        stats = self.get_summary_stats()
        anomalies = self.detect_anomalies()
        recommendations = self.generate_recommendations()
        
        html = """<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OpenClaw Performance Analysis Report</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f5f5;
        }
        .container {
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        h1 {
            color: #2c3e50;
            border-bottom: 3px solid #3498db;
            padding-bottom: 10px;
        }
        h2 {
            color: #34495e;
            margin-top: 30px;
        }
        .summary-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin: 20px 0;
        }
        .summary-card {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 20px;
            border-radius: 8px;
        }
        .summary-card h3 {
            margin: 0 0 10px 0;
            font-size: 14px;
            opacity: 0.9;
        }
        .summary-card .value {
            font-size: 32px;
            font-weight: bold;
            margin: 0;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin: 20px 0;
        }
        th, td {
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid #e0e0e0;
        }
        th {
            background: #f8f9fa;
            font-weight: 600;
        }
        tr:hover {
            background: #f8f9fa;
        }
        .anomaly-critical { background: #fee; }
        .anomaly-high { background: #fff4e6; }
        .anomaly-medium { background: #fffde7; }
        .badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 600;
        }
        .badge-critical { background: #e74c3c; color: white; }
        .badge-high { background: #e67e22; color: white; }
        .badge-medium { background: #f39c12; color: white; }
        .badge-low { background: #95a5a6; color: white; }
        .trend-up { color: #e74c3c; }
        .trend-down { color: #27ae60; }
        .trend-stable { color: #95a5a6; }
        .recommendation {
            background: #fff3cd;
            border-left: 4px solid #ffc107;
            padding: 12px;
            margin: 10px 0;
            border-radius: 4px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>📊 OpenClaw Performance Analysis Report</h1>
        <p><strong>Generated:</strong> """ + datetime.now().strftime('%Y-%m-%d %H:%M:%S') + """</p>
        
        <h2>📈 Summary</h2>
        <div class="summary-grid">
"""
        
        # Summary cards
        if stats:
            time_range = stats.get('time_range', {})
            ops = stats.get('operations', {})
            
            html += f"""
            <div class="summary-card">
                <h3>Data Points</h3>
                <p class="value">{stats.get('total_data_points', 0)}</p>
            </div>
            <div class="summary-card">
                <h3>Duration</h3>
                <p class="value">{time_range.get('duration_human', 'N/A')}</p>
            </div>
            <div class="summary-card">
                <h3>Total Operations</h3>
                <p class="value">{ops.get('total_operations', 0):,}</p>
            </div>
            <div class="summary-card">
                <h3>Error Rate</h3>
                <p class="value">{ops.get('overall_error_rate', 0):.2f}%</p>
            </div>
"""
        
        html += """
        </div>
        
        <h2>📊 Metrics Analysis</h2>
        <table>
            <thead>
                <tr>
                    <th>Metric</th>
                    <th>Count</th>
                    <th>Mean</th>
                    <th>Median</th>
                    <th>Std Dev</th>
                    <th>Min</th>
                    <th>Max</th>
                    <th>P95</th>
                    <th>P99</th>
                    <th>Trend</th>
                </tr>
            </thead>
            <tbody>
"""
        
        # Metrics rows
        for name, result in self.analysis_cache.items():
            trend_class = 'trend-up' if result.trend == 'increasing' else 'trend-down' if result.trend == 'decreasing' else 'trend-stable'
            trend_icon = '↑' if result.trend == 'increasing' else '↓' if result.trend == 'decreasing' else '→'
            
            html += f"""
                <tr>
                    <td><strong>{result.name}</strong></td>
                    <td>{result.count}</td>
                    <td>{result.mean:.2f}</td>
                    <td>{result.median:.2f}</td>
                    <td>{result.std_dev:.2f}</td>
                    <td>{result.min_val:.2f}</td>
                    <td>{result.max_val:.2f}</td>
                    <td>{result.p95:.2f}</td>
                    <td>{result.p99:.2f}</td>
                    <td class="{trend_class}">{trend_icon} {result.trend}</td>
                </tr>
"""
        
        html += """
            </tbody>
        </table>
"""
        
        # Anomalies
        html += """
        <h2>⚠️ Anomalies</h2>
"""
        
        if anomalies:
            html += """
        <table>
            <thead>
                <tr>
                    <th>Severity</th>
                    <th>Metric</th>
                    <th>Value</th>
                    <th>Expected</th>
                    <th>Deviation</th>
                    <th>Z-Score</th>
                    <th>Time</th>
                </tr>
            </thead>
            <tbody>
"""
            
            for anomaly in anomalies[:20]:
                row_class = f'anomaly-{anomaly.severity}' if anomaly.severity in ['critical', 'high', 'medium'] else ''
                badge_class = f'badge-{anomaly.severity}'
                
                html += f"""
                <tr class="{row_class}">
                    <td><span class="badge {badge_class}">{anomaly.severity.upper()}</span></td>
                    <td>{anomaly.metric}</td>
                    <td><strong>{anomaly.value:.2f}</strong></td>
                    <td>{anomaly.expected:.2f}</td>
                    <td>{anomaly.deviation:.2f}</td>
                    <td>{anomaly.z_score:.2f}</td>
                    <td>{datetime.fromtimestamp(anomaly.timestamp).strftime('%H:%M:%S')}</td>
                </tr>
"""
            
            html += """
            </tbody>
        </table>
"""
            
            if len(anomalies) > 20:
                html += f"""
        <p><em>Showing top 20 of {len(anomalies)} anomalies</em></p>
"""
        else:
            html += """
        <p style="color: #27ae60;">✅ No anomalies detected</p>
"""
        
        # Recommendations
        html += """
        <h2>💡 Recommendations</h2>
"""
        
        if recommendations:
            for rec in recommendations:
                html += f"""
        <div class="recommendation">
            {rec}
        </div>
"""
        else:
            html += """
        <p>No recommendations at this time.</p>
"""
        
        html += """
    </div>
</body>
</html>
"""
        
        return html
    
    def _generate_markdown_report(self) -> str:
        """Generate Markdown report"""
        stats = self.get_summary_stats()
        anomalies = self.detect_anomalies()
        
        md = f"""# OpenClaw Performance Analysis Report

**Generated:** {datetime.now().isoformat()}

## 📊 Summary

| Metric | Value |
|--------|-------|
| Total Data Points | {stats.get('total_data_points', 0)} |
"""
        
        time_range = stats.get('time_range', {})
        if time_range:
            md += f"| Time Range | {time_range.get('start', 'N/A')} to {time_range.get('end', 'N/A')} |\n"
            md += f"| Duration | {time_range.get('duration_human', 'N/A')} |\n"
        
        ops = stats.get('operations', {})
        if ops:
            md += f"| Total Operations | {ops.get('total_operations', 0):,} |\n"
            md += f"| Error Rate | {ops.get('overall_error_rate', 0):.2f}% |\n"
        
        md += "\n## 📈 Metrics Analysis\n\n"
        md += "| Metric | Count | Mean | Median | Std Dev | Min | Max | P95 | P99 | Trend |\n"
        md += "|--------|-------|------|--------|---------|-----|-----|-----|-----|-------|\n"
        
        for name, result in self.analysis_cache.items():
            trend_icon = '↑' if result.trend == 'increasing' else '↓' if result.trend == 'decreasing' else '→'
            md += f"| {result.name} | {result.count} | {result.mean:.2f} | {result.median:.2f} | {result.std_dev:.2f} | {result.min_val:.2f} | {result.max_val:.2f} | {result.p95:.2f} | {result.p99:.2f} | {trend_icon} {result.trend} |\n"
        
        md += "\n## ⚠️ Anomalies\n\n"
        
        if anomalies:
            md += "| Severity | Metric | Value | Expected | Z-Score | Time |\n"
            md += "|----------|--------|-------|----------|---------|------|\n"
            
            for anomaly in anomalies[:10]:
                md += f"| **{anomaly.severity.upper()}** | {anomaly.metric} | {anomaly.value:.2f} | {anomaly.expected:.2f} | {anomaly.z_score:.2f} | {datetime.fromtimestamp(anomaly.timestamp).strftime('%H:%M:%S')} |\n"
            
            if len(anomalies) > 10:
                md += f"\n*... and {len(anomalies) - 10} more anomalies*\n"
        else:
            md += "No anomalies detected.\n"
        
        recommendations = self.generate_recommendations()
        if recommendations:
            md += "\n## 💡 Recommendations\n\n"
            for i, rec in enumerate(recommendations, 1):
                md += f"{i}. {rec}\n"
        else:
            md += "\n## 💡 Recommendations\n\nNo recommendations at this time.\n"
        
        return md


# CLI Interface

def main():
    """Command-line interface"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description='OpenClaw Performance Data Analyzer',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Analyze JSON file and show text report
  python -m openclaw.analytics.data_analyzer -i metrics.json
  
  # Generate HTML report
  python -m openclaw.analytics.data_analyzer -i metrics.json -o report.html -f html
  
  # Export analysis as JSON
  python -m openclaw.analytics.data_analyzer -i metrics.json -e analysis.json
        """
    )
    
    parser.add_argument('-i', '--input', required=True, help='Input file (JSON or CSV)')
    parser.add_argument('-o', '--output', help='Output report file')
    parser.add_argument('-f', '--format', choices=['text', 'json', 'html', 'markdown'], 
                        default='text', help='Report format (default: text)')
    parser.add_argument('-e', '--export', help='Export analysis to file')
    parser.add_argument('-t', '--threshold', type=float, default=2.5, 
                        help='Anomaly detection threshold (default: 2.5)')
    
    args = parser.parse_args()
    
    # Create analyzer
    analyzer = DataAnalyzer(config={'anomaly_threshold': args.threshold})
    
    # Load data
    print(f"📂 Loading data from {args.input}...")
    
    if args.input.endswith('.json'):
        count = analyzer.load_from_json(args.input)
    elif args.input.endswith('.csv'):
        count = analyzer.load_from_csv(args.input)
    else:
        print("❌ Error: Unsupported file format. Use .json or .csv")
        sys.exit(1)
    
    print(f"✅ Loaded {count} data points")
    
    # Perform analysis
    print("🔍 Analyzing data...")
    results = analyzer.analyze()
    print(f"✅ Analyzed {len(results)} metrics")
    
    # Detect anomalies
    anomalies = analyzer.detect_anomalies()
    print(f"⚠️  Detected {len(anomalies)} anomalies")
    
    # Generate report
    report = analyzer.generate_report(format=args.format)
    
    # Output
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(report)
        print(f"✅ Report saved to {args.output}")
    else:
        print("\n" + report)
    
    # Export if requested
    if args.export:
        export_format = 'json' if args.export.endswith('.json') else 'csv'
        analyzer.export_analysis(args.export, export_format)
        print(f"✅ Analysis exported to {args.export}")


if __name__ == '__main__':
    main()
