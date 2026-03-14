"""
Basic usage example for OpenClaw Analytics
"""

import json
from openclaw.analytics import DataAnalyzer, MetricPoint


def example_basic_usage():
    """Basic usage example"""
    print("=" * 60)
    print("OpenClaw Analytics - Basic Usage Example")
    print("=" * 60)
    
    # Create analyzer
    analyzer = DataAnalyzer()
    
    # Add some metric points
    for i in range(10):
        point = MetricPoint(
            timestamp=1640000000.0 + i * 60,
            cpu_usage=40.0 + i * 2,
            memory_used=1000000000 + i * 10000000,
            memory_total=2000000000,
            agent_executions=10 + i,
            model_requests=20 + i * 2,
            ws_latency=40.0 + i,
            error_count=1 if i % 5 == 0 else 0
        )
        analyzer.add_metric_point(point)
    
    # Perform analysis
    print("\n[1] Performing analysis...")
    results = analyzer.analyze()
    
    # Print CPU analysis
    if 'cpu_usage' in results:
        cpu = results['cpu_usage']
        print(f"\nCPU Usage Analysis:")
        print(f"  Mean: {cpu.mean:.2f}%")
        print(f"  Median: {cpu.median:.2f}%")
        print(f"  Std Dev: {cpu.std_dev:.2f}%")
        print(f"  Trend: {cpu.trend}")
        print(f"  P95: {cpu.p95:.2f}%")
    
    # Detect anomalies
    print("\n[2] Detecting anomalies...")
    anomalies = analyzer.detect_anomalies(threshold=2.0)
    
    if anomalies:
        print(f"\nFound {len(anomalies)} anomalies:")
        for anomaly in anomalies[:5]:  # Show first 5
            print(f"  [{anomaly.severity.upper()}] {anomaly.metric}")
            print(f"    Value: {anomaly.value:.2f}")
            print(f"    Z-Score: {anomaly.z_score:.2f}")
    else:
        print("  No anomalies detected")
    
    # Generate recommendations
    print("\n[3] Generating recommendations...")
    recommendations = analyzer.generate_recommendations()
    
    if recommendations:
        print(f"\nRecommendations:")
        for i, rec in enumerate(recommendations, 1):
            print(f"  {i}. {rec}")
    else:
        print("  No recommendations")
    
    # Generate text report
    print("\n[4] Generating report...")
    report = analyzer.generate_report(format='text')
    print("\n" + report)


def example_load_from_file():
    """Example loading from JSON file"""
    print("\n" + "=" * 60)
    print("Loading from File Example")
    print("=" * 60)
    
    analyzer = DataAnalyzer()
    
    # Load from JSON file
    try:
        count = analyzer.load_from_json('tests/fixtures/sample_metrics.json')
        print(f"\nLoaded {count} data points")
        
        # Analyze
        results = analyzer.analyze()
        
        # Show summary
        stats = analyzer.get_summary_stats()
        print(f"\nSummary:")
        print(f"  Data Points: {stats['total_data_points']}")
        print(f"  Time Range: {stats['time_range']['start']} to {stats['time_range']['end']}")
        print(f"  Duration: {stats['time_range']['duration']}")
        print(f"  Total Executions: {stats['operations']['total_executions']}")
        print(f"  Total Requests: {stats['operations']['total_requests']}")
        print(f"  Total Errors: {stats['operations']['total_errors']}")
        print(f"  Error Rate: {stats['operations']['error_rate']:.2f}%")
        
    except FileNotFoundError:
        print("Sample file not found. Run from project root.")


def example_export_reports():
    """Example exporting reports"""
    print("\n" + "=" * 60)
    print("Export Reports Example")
    print("=" * 60)
    
    analyzer = DataAnalyzer()
    
    # Add data
    for i in range(20):
        analyzer.add_metric_point(MetricPoint(
            timestamp=1640000000.0 + i * 60,
            cpu_usage=50.0 + (i % 10) * 2,
            memory_used=1500000000,
            memory_total=2000000000
        ))
    
    analyzer.analyze()
    
    # Export as JSON
    print("\n[1] Exporting JSON report...")
    analyzer.export_analysis('/tmp/analysis.json', format='json')
    print("  ✓ Saved to /tmp/analysis.json")
    
    # Export as HTML
    print("\n[2] Exporting HTML report...")
    report_html = analyzer.generate_report(format='html')
    with open('/tmp/analysis.html', 'w') as f:
        f.write(report_html)
    print("  ✓ Saved to /tmp/analysis.html")
    
    # Export as Markdown
    print("\n[3] Exporting Markdown report...")
    report_md = analyzer.generate_report(format='markdown')
    with open('/tmp/analysis.md', 'w') as f:
        f.write(report_md)
    print("  ✓ Saved to /tmp/analysis.md")


if __name__ == '__main__':
    example_basic_usage()
    example_load_from_file()
    example_export_reports()
