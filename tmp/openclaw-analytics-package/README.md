# OpenClaw Analytics

[![Python](https://img.shields.io/badge/Python-3.8+-blue.svg)](https://www.python.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Code Style](https://img.shields.io/badge/code%20style-black-000000.svg)](https://github.com/psf/black)

A comprehensive data analysis toolkit for OpenClaw performance metrics. This package provides statistical analysis, anomaly detection, trend analysis, and report generation capabilities.

## ✨ Features

- 📊 **Statistical Analysis** - Mean, median, standard deviation, percentiles (P95, P99)
- 🔍 **Anomaly Detection** - Z-score based anomaly detection with severity levels
- 📈 **Trend Analysis** - Detect increasing, decreasing, or stable trends
- 📑 **Multi-format Reports** - Generate reports in Text, JSON, HTML, or Markdown
- 💡 **Smart Recommendations** - Actionable insights based on analysis
- 🔌 **Multiple Data Sources** - Load from JSON, CSV, or programmatic API
- 🎯 **Zero Dependencies** - Pure Python standard library implementation
- ⚡ **High Performance** - Optimized for large datasets

## 📦 Installation

### From Source

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw/packages/analytics
pip install -e .
```

### Using pip (when published)

```bash
pip install openclaw-analytics
```

## 🚀 Quick Start

### Command Line

```bash
# Analyze metrics file
python -m openclaw.analytics.data_analyzer -i metrics.json

# Generate HTML report
python -m openclaw.analytics.data_analyzer -i metrics.json -o report.html -f html

# Export analysis as JSON
python -m openclaw.analytics.data_analyzer -i metrics.json -e analysis.json
```

### Python API

```python
from openclaw.analytics import DataAnalyzer, MetricPoint

# Create analyzer
analyzer = DataAnalyzer()

# Load data from file
analyzer.load_from_json('metrics.json')

# Or add data points programmatically
point = MetricPoint(
    timestamp=1640000000.0,
    cpu_usage=45.5,
    memory_used=1024000000,
    memory_total=2048000000,
    agent_executions=10,
    model_requests=25,
    ws_latency=45.2,
    error_count=1
)
analyzer.add_metric_point(point)

# Perform analysis
results = analyzer.analyze()

# Detect anomalies
anomalies = analyzer.detect_anomalies(threshold=2.5)

# Generate reports
text_report = analyzer.generate_report(format='text')
html_report = analyzer.generate_report(format='html')
json_report = analyzer.generate_report(format='json')
markdown_report = analyzer.generate_report(format='markdown')

# Get recommendations
recommendations = analyzer.generate_recommendations()

# Export analysis
analyzer.export_analysis('analysis.json', format='json')
```

## 📖 Documentation

### DataAnalyzer Class

The main class for performance data analysis.

#### Initialization

```python
analyzer = DataAnalyzer(config={
    'anomaly_threshold': 2.5,     # Z-score threshold for anomaly detection
    'trend_threshold': 10,        # Percentage change for trend detection
    'min_data_points': 3          # Minimum data points for analysis
})
```

#### Methods

| Method | Description |
|--------|-------------|
| `load_from_json(filepath)` | Load metrics from JSON file |
| `load_from_csv(filepath)` | Load metrics from CSV file |
| `add_metric_point(point)` | Add a single metric point |
| `analyze()` | Perform comprehensive analysis |
| `detect_anomalies(threshold)` | Detect anomalies in data |
| `generate_recommendations()` | Generate actionable recommendations |
| `generate_report(format)` | Generate report in specified format |
| `export_analysis(filepath, format)` | Export analysis to file |
| `get_summary_stats()` | Get summary statistics |
| `clear()` | Clear all cached data |

### MetricPoint Dataclass

```python
@dataclass
class MetricPoint:
    timestamp: float          # Unix timestamp
    cpu_usage: float         # CPU usage percentage
    memory_used: float       # Memory used (bytes)
    memory_total: float      # Total memory (bytes)
    agent_executions: int    # Number of agent executions
    model_requests: int      # Number of model requests
    ws_latency: float        # WebSocket latency (ms)
    error_count: int         # Number of errors
```

### AnalysisResult Dataclass

```python
@dataclass
class AnalysisResult:
    name: str          # Metric name
    count: int         # Number of data points
    mean: float        # Mean value
    median: float      # Median value
    std_dev: float     # Standard deviation
    min_val: float     # Minimum value
    max_val: float     # Maximum value
    p95: float         # 95th percentile
    p99: float         # 99th percentile
    trend: str         # Trend direction
    slope: float       # Linear regression slope
```

### Anomaly Dataclass

```python
@dataclass
class Anomaly:
    timestamp: float   # When anomaly occurred
    metric: str        # Metric name
    value: float       # Actual value
    expected: float    # Expected value (mean)
    deviation: float   # Deviation from expected
    z_score: float     # Z-score
    severity: str      # 'low', 'medium', 'high', 'critical'
```

## 📊 Data Format

### JSON Format

```json
{
  "timestamp": 1640000000,
  "cpuUsage": 45.5,
  "memoryUsage": {
    "heapUsed": 1024000000,
    "heapTotal": 2048000000
  },
  "agentMetrics": [
    {
      "executionCount": 10,
      "errorCount": 1
    }
  ],
  "modelMetrics": [
    {
      "requestCount": 25,
      "errorRate": 4.0
    }
  ],
  "websocketMetrics": {
    "averageLatency": 45.2
  }
}
```

### CSV Format

```csv
timestamp,cpu_usage,memory_used,memory_total,agent_executions,model_requests,ws_latency,error_count
1640000000,45.5,1024000000,2048000000,10,25,45.2,1
```

## 📈 Example Output

### Text Report

```
======================================================================
OpenClaw Performance Analysis Report
======================================================================

Generated at: 2024-01-15T10:30:00

--- Summary ---
Total Data Points: 100
Time Range: 2024-01-15T09:00:00 to 2024-01-15T10:30:00
Duration: 1:30:00
Total Agent Executions: 150
Total Model Requests: 350
Total Errors: 5
Overall Error Rate: 1.00%

--- Metrics Analysis ---

CPU Usage (%):
  Count: 100
  Mean: 45.23
  Median: 44.50
  Std Dev: 12.34
  Min: 20.10
  Max: 78.90
  P95: 65.40
  P99: 72.30
  Trend: stable

--- Anomalies (2 detected) ---

[HIGH] cpu_usage
  Value: 78.90
  Expected: 45.23
  Z-Score: 2.73
  Time: 2024-01-15T10:15:00

--- Recommendations ---

1. ⚠️ High CPU usage detected (avg: 45.23%). Consider optimizing compute-intensive operations.
2. 📈 WebSocket latency is increasing. Investigate potential bottlenecks.

======================================================================
```

### HTML Report

Beautiful, responsive HTML report with charts and tables (see example in `/examples`).

## 🧪 Testing

```bash
# Run tests
python -m pytest tests/

# Run with coverage
python -m pytest tests/ --cov=openclaw.analytics
```

## 📁 Project Structure

```
openclaw-analytics/
├── openclaw/
│   ├── __init__.py
│   └── analytics/
│       ├── __init__.py
│       └── data_analyzer.py
├── tests/
│   ├── __init__.py
│   ├── test_data_analyzer.py
│   └── fixtures/
│       └── sample_metrics.json
├── examples/
│   ├── basic_usage.py
│   ├── sample_metrics.json
│   └── sample_report.html
├── docs/
│   ├── API.md
│   └── EXAMPLES.md
├── README.md
├── LICENSE
├── pyproject.toml
└── requirements-dev.txt
```

## 🔧 Configuration

### Environment Variables

- `OPENCLAW_ANALYTICS_THRESHOLD` - Default anomaly threshold (default: 2.5)
- `OPENCLAW_ANALYTICS_MIN_POINTS` - Minimum data points (default: 3)

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Development Setup

```bash
# Clone repository
git clone https://github.com/openclaw/openclaw.git
cd openclaw/packages/analytics

# Create virtual environment
python -m venv venv
source venv/bin/activate  # or `venv\Scripts\activate` on Windows

# Install development dependencies
pip install -e ".[dev]"

# Run tests
python -m pytest

# Format code
black openclaw/
isort openclaw/

# Type check
mypy openclaw/
```

## 📝 License

MIT License - see [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- OpenClaw Team
- All contributors

## 📞 Support

- **GitHub Issues**: https://github.com/openclaw/openclaw/issues
- **Documentation**: https://openclaw.ai/docs/analytics
- **Email**: team@openclaw.ai

## 🔗 Related Projects

- [OpenClaw Core](https://github.com/openclaw/openclaw) - Main OpenClaw project
- [OpenClaw Performance Monitor](https://github.com/openclaw/openclaw/tree/main/packages/performance-monitor) - TypeScript performance monitoring

---

**Made with ❤️ by the OpenClaw Team**
