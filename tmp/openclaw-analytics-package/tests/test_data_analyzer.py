"""
Tests for OpenClaw Analytics Data Analyzer
"""

import pytest
import json
import tempfile
import os
from datetime import datetime
from openclaw.analytics import DataAnalyzer, MetricPoint, AnalysisResult, Anomaly


class TestMetricPoint:
    """Test MetricPoint dataclass"""
    
    def test_create_metric_point(self):
        """Test creating a metric point"""
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
        
        assert point.timestamp == 1640000000.0
        assert point.cpu_usage == 45.5
        assert point.memory_percent == 50.0
    
    def test_memory_percent_zero_total(self):
        """Test memory percent when total is zero"""
        point = MetricPoint(
            timestamp=1640000000.0,
            memory_used=1024000000,
            memory_total=0
        )
        
        assert point.memory_percent == 0.0


class TestDataAnalyzer:
    """Test DataAnalyzer class"""
    
    @pytest.fixture
    def analyzer(self):
        """Create analyzer instance"""
        return DataAnalyzer()
    
    @pytest.fixture
    def sample_data(self):
        """Create sample data points"""
        return [
            MetricPoint(
                timestamp=1640000000.0 + i * 60,
                cpu_usage=40.0 + i * 2,
                memory_used=1000000000 + i * 10000000,
                memory_total=2000000000,
                agent_executions=10 + i,
                model_requests=20 + i * 2,
                ws_latency=40.0 + i,
                error_count=1 if i % 10 == 0 else 0
            )
            for i in range(50)
        ]
    
    @pytest.fixture
    def sample_json_file(self, tmp_path):
        """Create sample JSON file"""
        data = [
            {
                "timestamp": 1640000000 + i * 60,
                "cpuUsage": 40.0 + i * 2,
                "memoryUsage": {
                    "heapUsed": 1000000000 + i * 10000000,
                    "heapTotal": 2000000000
                },
                "agentMetrics": [
                    {"executionCount": 10 + i, "errorCount": 1 if i % 10 == 0 else 0}
                ],
                "modelMetrics": [
                    {"requestCount": 20 + i * 2}
                ],
                "websocketMetrics": {
                    "averageLatency": 40.0 + i
                }
            }
            for i in range(50)
        ]
        
        file_path = tmp_path / "metrics.json"
        with open(file_path, 'w') as f:
            json.dump(data, f)
        
        return str(file_path)
    
    @pytest.fixture
    def sample_csv_file(self, tmp_path):
        """Create sample CSV file"""
        csv_content = "timestamp,cpu_usage,memory_used,memory_total,agent_executions,model_requests,ws_latency,error_count\n"
        
        for i in range(50):
            csv_content += f"{1640000000 + i * 60},{40.0 + i * 2},{1000000000 + i * 10000000},{2000000000},{10 + i},{20 + i * 2},{40.0 + i},{1 if i % 10 == 0 else 0}\n"
        
        file_path = tmp_path / "metrics.csv"
        with open(file_path, 'w') as f:
            f.write(csv_content)
        
        return str(file_path)
    
    def test_initialization(self, analyzer):
        """Test analyzer initialization"""
        assert analyzer.data_points == []
        assert analyzer.analysis_cache == {}
        assert analyzer.anomaly_cache == []
    
    def test_load_from_json(self, analyzer, sample_json_file):
        """Test loading data from JSON file"""
        count = analyzer.load_from_json(sample_json_file)
        
        assert count == 50
        assert len(analyzer.data_points) == 50
        assert all(isinstance(p, MetricPoint) for p in analyzer.data_points)
    
    def test_load_from_csv(self, analyzer, sample_csv_file):
        """Test loading data from CSV file"""
        count = analyzer.load_from_csv(sample_csv_file)
        
        assert count == 50
        assert len(analyzer.data_points) == 50
    
    def test_add_metric_point(self, analyzer):
        """Test adding metric point"""
        point = MetricPoint(timestamp=1640000000.0)
        analyzer.add_metric_point(point)
        
        assert len(analyzer.data_points) == 1
        assert analyzer.data_points[0] == point
    
    def test_analyze(self, analyzer, sample_data):
        """Test analysis"""
        for point in sample_data:
            analyzer.add_metric_point(point)
        
        results = analyzer.analyze()
        
        assert 'cpu_usage' in results
        assert 'memory_usage' in results
        assert 'ws_latency' in results
        
        cpu_result = results['cpu_usage']
        assert isinstance(cpu_result, AnalysisResult)
        assert cpu_result.count == 50
        assert cpu_result.mean > 0
        assert cpu_result.trend in ['increasing', 'decreasing', 'stable']
    
    def test_detect_anomalies(self, analyzer):
        """Test anomaly detection"""
        # Add normal data
        for i in range(30):
            analyzer.add_metric_point(MetricPoint(
                timestamp=1640000000.0 + i * 60,
                cpu_usage=40.0 + i * 0.5,
                memory_used=1000000000,
                memory_total=2000000000
            ))
        
        # Add anomaly
        analyzer.add_metric_point(MetricPoint(
            timestamp=1640000000.0 + 30 * 60,
            cpu_usage=90.0,  # Very high CPU
            memory_used=1000000000,
            memory_total=2000000000
        ))
        
        analyzer.analyze()
        anomalies = analyzer.detect_anomalies(threshold=2.0)
        
        assert len(anomalies) > 0
        assert any(a.metric == 'cpu_usage' for a in anomalies)
        assert any(a.severity in ['low', 'medium', 'high', 'critical'] for a in anomalies)
    
    def test_generate_recommendations(self, analyzer, sample_data):
        """Test recommendation generation"""
        for point in sample_data:
            analyzer.add_metric_point(point)
        
        analyzer.analyze()
        recommendations = analyzer.generate_recommendations()
        
        assert isinstance(recommendations, list)
        assert all(isinstance(r, str) for r in recommendations)
    
    def test_generate_text_report(self, analyzer, sample_data):
        """Test text report generation"""
        for point in sample_data:
            analyzer.add_metric_point(point)
        
        report = analyzer.generate_report(format='text')
        
        assert isinstance(report, str)
        assert 'OpenClaw Performance Analysis Report' in report
        assert 'Summary' in report
        assert 'Metrics Analysis' in report
    
    def test_generate_json_report(self, analyzer, sample_data):
        """Test JSON report generation"""
        for point in sample_data:
            analyzer.add_metric_point(point)
        
        report = analyzer.generate_report(format='json')
        
        assert isinstance(report, str)
        
        # Parse JSON to verify structure
        data = json.loads(report)
        assert 'generated_at' in data
        assert 'summary' in data
        assert 'metrics' in data
    
    def test_generate_html_report(self, analyzer, sample_data):
        """Test HTML report generation"""
        for point in sample_data:
            analyzer.add_metric_point(point)
        
        report = analyzer.generate_report(format='html')
        
        assert isinstance(report, str)
        assert '<!DOCTYPE html>' in report
        assert '<title>OpenClaw Performance Analysis Report</title>' in report
    
    def test_generate_markdown_report(self, analyzer, sample_data):
        """Test Markdown report generation"""
        for point in sample_data:
            analyzer.add_metric_point(point)
        
        report = analyzer.generate_report(format='markdown')
        
        assert isinstance(report, str)
        assert '# OpenClaw Performance Analysis Report' in report
        assert '## 📊 Summary' in report
    
    def test_get_summary_stats(self, analyzer, sample_data):
        """Test summary statistics"""
        for point in sample_data:
            analyzer.add_metric_point(point)
        
        stats = analyzer.get_summary_stats()
        
        assert 'total_data_points' in stats
        assert stats['total_data_points'] == 50
        assert 'time_range' in stats
        assert 'operations' in stats
    
    def test_export_analysis_json(self, analyzer, sample_data, tmp_path):
        """Test exporting analysis as JSON"""
        for point in sample_data:
            analyzer.add_metric_point(point)
        
        output_file = tmp_path / "analysis.json"
        analyzer.export_analysis(str(output_file), format='json')
        
        assert os.path.exists(output_file)
        
        with open(output_file, 'r') as f:
            data = json.load(f)
        
        assert 'generated_at' in data
    
    def test_export_analysis_csv(self, analyzer, sample_data, tmp_path):
        """Test exporting analysis as CSV"""
        for point in sample_data:
            analyzer.add_metric_point(point)
        
        output_file = tmp_path / "analysis.csv"
        analyzer.export_analysis(str(output_file), format='csv')
        
        assert os.path.exists(output_file)
        
        with open(output_file, 'r') as f:
            content = f.read()
        
        assert 'metric,count,mean' in content
    
    def test_clear(self, analyzer, sample_data):
        """Test clearing data"""
        for point in sample_data:
            analyzer.add_metric_point(point)
        
        analyzer.analyze()
        analyzer.clear()
        
        assert len(analyzer.data_points) == 0
        assert len(analyzer.analysis_cache) == 0
        assert len(analyzer.anomaly_cache) == 0
    
    def test_trend_detection_increasing(self, analyzer):
        """Test detecting increasing trend"""
        # Add data with increasing CPU usage
        for i in range(50):
            analyzer.add_metric_point(MetricPoint(
                timestamp=1640000000.0 + i * 60,
                cpu_usage=20.0 + i * 2  # Clear increasing trend
            ))
        
        results = analyzer.analyze()
        assert results['cpu_usage'].trend == 'increasing'
    
    def test_trend_detection_decreasing(self, analyzer):
        """Test detecting decreasing trend"""
        # Add data with decreasing CPU usage
        for i in range(50):
            analyzer.add_metric_point(MetricPoint(
                timestamp=1640000000.0 + i * 60,
                cpu_usage=100.0 - i * 1.5  # Clear decreasing trend
            ))
        
        results = analyzer.analyze()
        assert results['cpu_usage'].trend == 'decreasing'
    
    def test_trend_detection_stable(self, analyzer):
        """Test detecting stable trend"""
        # Add data with stable CPU usage
        import random
        random.seed(42)
        
        for i in range(50):
            analyzer.add_metric_point(MetricPoint(
                timestamp=1640000000.0 + i * 60,
                cpu_usage=50.0 + random.uniform(-2, 2)  # Small fluctuations
            ))
        
        results = analyzer.analyze()
        assert results['cpu_usage'].trend == 'stable'
    
    def test_invalid_json_file(self, analyzer, tmp_path):
        """Test handling invalid JSON file"""
        file_path = tmp_path / "invalid.json"
        with open(file_path, 'w') as f:
            f.write("invalid json content")
        
        with pytest.raises(json.JSONDecodeError):
            analyzer.load_from_json(str(file_path))
    
    def test_empty_data_analysis(self, analyzer):
        """Test analysis with no data"""
        results = analyzer.analyze()
        assert results == {}
    
    def test_insufficient_data_points(self, analyzer):
        """Test analysis with insufficient data points"""
        for i in range(2):
            analyzer.add_metric_point(MetricPoint(
                timestamp=1640000000.0 + i * 60,
                cpu_usage=40.0
            ))
        
        results = analyzer.analyze()
        # Should handle gracefully with few data points
        assert 'cpu_usage' in results


class TestAnalysisResult:
    """Test AnalysisResult dataclass"""
    
    def test_to_dict(self):
        """Test converting result to dictionary"""
        result = AnalysisResult(
            name='CPU Usage',
            count=100,
            mean=45.5,
            median=44.0,
            std_dev=12.3,
            min_val=20.0,
            max_val=80.0,
            p95=70.0,
            p99=75.0,
            trend='stable',
            slope=0.05,
            last_value=45.0,
            first_value=40.0
        )
        
        data = result.to_dict()
        
        assert data['name'] == 'CPU Usage'
        assert data['count'] == 100
        assert data['mean'] == 45.5
        assert data['trend'] == 'stable'


class TestAnomaly:
    """Test Anomaly dataclass"""
    
    def test_to_dict(self):
        """Test converting anomaly to dictionary"""
        anomaly = Anomaly(
            timestamp=1640000000.0,
            metric='cpu_usage',
            value=90.0,
            expected=45.0,
            deviation=45.0,
            z_score=3.5,
            severity='high'
        )
        
        data = anomaly.to_dict()
        
        assert data['metric'] == 'cpu_usage'
        assert data['value'] == 90.0
        assert data['severity'] == 'high'
        assert 'datetime' in data


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
