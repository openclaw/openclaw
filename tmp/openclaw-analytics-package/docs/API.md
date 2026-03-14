# OpenClaw Analytics - API Documentation

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [API Reference](#api-reference)
  - [DataAnalyzer](#dataanalyzer)
  - [MetricPoint](#metricpoint)
  - [AnalysisResult](#analysisresult)
  - [Anomaly](#anomaly)
- [Report Formats](#report-formats)
- [Examples](#examples)

## Overview

OpenClaw Analytics is a comprehensive data analysis toolkit for analyzing OpenClaw performance metrics. It provides statistical analysis, anomaly detection, trend analysis, and report generation capabilities.

## Installation

```bash
pip install openclaw-analytics
```

## Quick Start

```python
from openclaw.analytics import DataAnalyzer, MetricPoint

# Create analyzer
analyzer = DataAnalyzer()

# Load data
analyzer.load_from_json('metrics.json')

# Analyze
results = analyzer.analyze()

# Detect anomalies
anomalies = analyzer.detect_anomalies()

# Generate report
report = analyzer.generate_report(format='html')
```

## API Reference

### DataAnalyzer

The main class for performance data analysis.

#### Constructor

```python
DataAnalyzer(config: Optional[Dict[str, Any]] = None)
```

**Parameters:**
- `config` (optional): Configuration dictionary with the following options:
  - `anomaly_threshold` (float): Z-score threshold for anomaly detection (default: 2.5)
  - `trend_threshold` (float): Percentage change threshold for trend detection (default: 10)
  - `min_data_points` (int): Minimum data points required for analysis (default: 3)

**Example:**
```python
analyzer = DataAnalyzer({
    'anomaly_threshold': 3.0,
    'trend_threshold': 15,
    'min_data_points': 5
})
```

#### Methods

##### load_from_json

```python
load_from_json(filepath: str) -> int
```

Load metrics data from a JSON file.

**Parameters:**
- `filepath`: Path to the JSON file

**Returns:** Number of data points loaded

**Raises:**
- `FileNotFoundError`: If file doesn't exist
- `json.JSONDecodeError`: If file is not valid JSON

**Example:**
```python
count = analyzer.load_from_json('metrics.json')
print(f"Loaded {count} data points")
```

##### load_from_csv

```python
load_from_csv(filepath: str) -> int
```

Load metrics data from a CSV file.

**Parameters:**
- `filepath`: Path to the CSV file

**Returns:** Number of data points loaded

**Raises:**
- `FileNotFoundError`: If file doesn't exist

**CSV Format:**
```csv
timestamp,cpu_usage,memory_used,memory_total,agent_executions,model_requests,ws_latency,error_count
1640000000,45.5,1024000000,2048000000,10,25,45.2,1
```

##### add_metric_point

```python
add_metric_point(point: MetricPoint) -> None
```

Add a single metric point programmatically.

**Parameters:**
- `point`: A `MetricPoint` instance

**Example:**
```python
point = MetricPoint(
    timestamp=time.time(),
    cpu_usage=45.5,
    memory_used=1024000000,
    memory_total=2048000000,
    agent_executions=10,
    model_requests=25,
    ws_latency=45.2,
    error_count=1
)
analyzer.add_metric_point(point)
```

##### analyze

```python
analyze() -> Dict[str, AnalysisResult]
```

Perform comprehensive analysis on loaded data.

**Returns:** Dictionary mapping metric names to `AnalysisResult` instances

**Metrics Analyzed:**
- `cpu_usage` - CPU usage percentage
- `memory_usage` - Memory usage percentage
- `ws_latency` - WebSocket latency (ms)
- `agent_executions` - Agent execution count
- `model_requests` - Model request count
- `error_count` - Error count

**Example:**
```python
results = analyzer.analyze()
cpu_result = results['cpu_usage']
print(f"CPU Mean: {cpu_result.mean}")
print(f"CPU Trend: {cpu_result.trend}")
```

##### detect_anomalies

```python
detect_anomalies(threshold: Optional[float] = None) -> List[Anomaly]
```

Detect anomalies in the data using Z-score method.

**Parameters:**
- `threshold` (optional): Z-score threshold (uses config default if not provided)

**Returns:** List of `Anomaly` instances

**Example:**
```python
anomalies = analyzer.detect_anomalies(threshold=2.5)
for anomaly in anomalies:
    print(f"[{anomaly.severity}] {anomaly.metric}: {anomaly.value}")
```

##### generate_recommendations

```python
generate_recommendations() -> List[str]
```

Generate actionable recommendations based on analysis.

**Returns:** List of recommendation strings

**Example:**
```python
recommendations = analyzer.generate_recommendations()
for i, rec in enumerate(recommendations, 1):
    print(f"{i}. {rec}")
```

##### generate_report

```python
generate_report(format: str = 'text') -> str
```

Generate a formatted report.

**Parameters:**
- `format`: Report format ('text', 'json', 'html', 'markdown')

**Returns:** Formatted report string

**Example:**
```python
html_report = analyzer.generate_report(format='html')
with open('report.html', 'w') as f:
    f.write(html_report)
```

##### export_analysis

```python
export_analysis(filepath: str, format: str = 'json') -> None
```

Export analysis results to a file.

**Parameters:**
- `filepath`: Output file path
- `format`: Export format ('json', 'csv')

**Example:**
```python
analyzer.export_analysis('analysis.json', format='json')
```

##### get_summary_stats

```python
get_summary_stats() -> Dict[str, Any]
```

Get summary statistics of loaded data.

**Returns:** Dictionary with summary statistics

**Example:**
```python
stats = analyzer.get_summary_stats()
print(f"Total data points: {stats['total_data_points']}")
print(f"Time range: {stats['time_range']}")
```

##### clear

```python
clear() -> None
```

Clear all loaded data and cached results.

**Example:**
```python
analyzer.clear()
```

### MetricPoint

Dataclass representing a single metric data point.

#### Fields

| Field | Type | Description | Required |
|-------|------|-------------|----------|
| `timestamp` | `float` | Unix timestamp | Yes |
| `cpu_usage` | `float` | CPU usage percentage | No |
| `memory_used` | `float` | Memory used (bytes) | No |
| `memory_total` | `float` | Total memory (bytes) | No |
| `agent_executions` | `int` | Number of agent executions | No |
| `model_requests` | `int` | Number of model requests | No |
| `ws_latency` | `float` | WebSocket latency (ms) | No |
| `error_count` | `int` | Number of errors | No |

#### Properties

##### memory_percent

```python
@property
memory_percent() -> float
```

Calculate memory usage percentage.

**Returns:** Memory usage percentage (0-100)

### AnalysisResult

Dataclass representing analysis results for a single metric.

#### Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | `str` | Metric name |
| `count` | `int` | Number of data points |
| `mean` | `float` | Mean value |
| `median` | `float` | Median value |
| `std_dev` | `float` | Standard deviation |
| `min_val` | `float` | Minimum value |
| `max_val` | `float` | Maximum value |
| `p95` | `float` | 95th percentile |
| `p99` | `float` | 99th percentile |
| `trend` | `str` | Trend direction ('increasing', 'decreasing', 'stable') |
| `slope` | `float` | Linear regression slope |
| `last_value` | `float` | Last recorded value |
| `first_value` | `float` | First recorded value |

#### Methods

##### to_dict

```python
to_dict() -> Dict[str, Any]
```

Convert to dictionary format.

### Anomaly

Dataclass representing a detected anomaly.

#### Fields

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | `float` | When anomaly occurred (Unix timestamp) |
| `metric` | `str` | Metric name |
| `value` | `float` | Actual value |
| `expected` | `float` | Expected value (mean) |
| `deviation` | `float` | Deviation from expected |
| `z_score` | `float` | Z-score |
| `severity` | `str` | Severity level ('low', 'medium', 'high', 'critical') |

#### Methods

##### to_dict

```python
to_dict() -> Dict[str, Any]
```

Convert to dictionary format with datetime string.

## Report Formats

### Text Format

Plain text report suitable for console output or log files.

```python
report = analyzer.generate_report(format='text')
```

### JSON Format

Structured JSON report for programmatic use.

```python
report = analyzer.generate_report(format='json')
data = json.loads(report)
```

### HTML Format

Styled HTML report with tables and charts.

```python
report = analyzer.generate_report(format='html')
with open('report.html', 'w') as f:
    f.write(report)
```

### Markdown Format

Markdown format for documentation or GitHub.

```python
report = analyzer.generate_report(format='markdown')
```

## Examples

### Complete Analysis Workflow

```python
from openclaw.analytics import DataAnalyzer, MetricPoint
import time
import random

# Create analyzer
analyzer = DataAnalyzer()

# Generate sample data
for i in range(100):
    analyzer.add_metric_point(MetricPoint(
        timestamp=time.time() - (100 - i) * 60,
        cpu_usage=40 + random.uniform(-10, 20),
        memory_used=1000000000 + random.uniform(-100000000, 200000000),
        memory_total=2000000000,
        agent_executions=int(10 + random.uniform(0, 20)),
        model_requests=int(20 + random.uniform(0, 30)),
        ws_latency=40 + random.uniform(-5, 30),
        error_count=1 if random.random() < 0.1 else 0
    ))

# Perform analysis
results = analyzer.analyze()

# Detect anomalies
anomalies = analyzer.detect_anomalies()

# Generate recommendations
recommendations = analyzer.generate_recommendations()

# Export results
analyzer.export_analysis('analysis.json')
analyzer.generate_report(format='html', output_file='report.html')

print(f"Analysis complete!")
print(f"Metrics analyzed: {len(results)}")
print(f"Anomalies detected: {len(anomalies)}")
print(f"Recommendations: {len(recommendations)}")
```

### Real-time Monitoring

```python
import time
from openclaw.analytics import DataAnalyzer, MetricPoint

analyzer = DataAnalyzer()

def collect_metrics():
    """Simulate collecting metrics from OpenClaw"""
    # In real scenario, this would fetch from OpenClaw API
    return MetricPoint(
        timestamp=time.time(),
        cpu_usage=get_cpu_usage(),
        memory_used=get_memory_used(),
        memory_total=get_memory_total(),
        agent_executions=get_agent_executions(),
        model_requests=get_model_requests(),
        ws_latency=get_ws_latency(),
        error_count=get_error_count()
    )

# Collect metrics every minute for an hour
for _ in range(60):
    point = collect_metrics()
    analyzer.add_metric_point(point)
    time.sleep(60)

# Analyze collected data
results = analyzer.analyze()
anomalies = analyzer.detect_anomalies()

# Alert on critical anomalies
for anomaly in anomalies:
    if anomaly.severity == 'critical':
        send_alert(f"Critical anomaly detected: {anomaly.metric}")
```

---

**For more examples, see the `/examples` directory.**
