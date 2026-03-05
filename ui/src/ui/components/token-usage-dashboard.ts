// Token使用统计Dashboard组件
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';

/**
 * Token使用统计Dashboard组件
 * 显示每日token消耗量和使用趋势
 */
@customElement('token-usage-dashboard')
export class TokenUsageDashboard extends LitElement {
  static styles = css`
    :host {
      display: block;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      color: var(--text-color, #333);
      background: var(--background-color, #f8f9fa);
    }

    .dashboard {
      padding: 1.5rem;
      max-width: 1200px;
      margin: 0 auto;
    }

    .dashboard-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2rem;
      padding-bottom: 1rem;
      border-bottom: 2px solid var(--border-color, #e9ecef);
    }

    .dashboard-title {
      font-size: 1.75rem;
      font-weight: 600;
      color: var(--primary-color, #2c3e50);
      margin: 0;
    }

    .dashboard-subtitle {
      font-size: 1rem;
      color: var(--secondary-color, #6c757d);
      margin-top: 0.25rem;
    }

    .period-selector {
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }

    .period-button {
      padding: 0.5rem 1rem;
      border: 1px solid var(--border-color, #dee2e6);
      background: var(--button-bg, #fff);
      color: var(--button-color, #495057);
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.875rem;
      transition: all 0.2s;
    }

    .period-button:hover {
      background: var(--button-hover-bg, #f8f9fa);
      border-color: var(--button-hover-border, #adb5bd);
    }

    .period-button.active {
      background: var(--primary-color, #2c3e50);
      color: white;
      border-color: var(--primary-color, #2c3e50);
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 1.5rem;
      margin-bottom: 2rem;
    }

    .stat-card {
      background: white;
      border-radius: 8px;
      padding: 1.5rem;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      border: 1px solid var(--border-color, #e9ecef);
    }

    .stat-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }

    .stat-title {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--secondary-color, #6c757d);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .stat-icon {
      width: 24px;
      height: 24px;
      color: var(--primary-color, #2c3e50);
    }

    .stat-value {
      font-size: 2rem;
      font-weight: 700;
      color: var(--primary-color, #2c3e50);
      margin: 0.5rem 0;
    }

    .stat-change {
      font-size: 0.875rem;
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }

    .stat-change.positive {
      color: var(--success-color, #28a745);
    }

    .stat-change.negative {
      color: var(--danger-color, #dc3545);
    }

    .stat-change.neutral {
      color: var(--secondary-color, #6c757d);
    }

    .charts-section {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 1.5rem;
      margin-bottom: 2rem;
    }

    @media (max-width: 768px) {
      .charts-section {
        grid-template-columns: 1fr;
      }
    }

    .chart-card {
      background: white;
      border-radius: 8px;
      padding: 1.5rem;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      border: 1px solid var(--border-color, #e9ecef);
    }

    .chart-title {
      font-size: 1.125rem;
      font-weight: 600;
      color: var(--primary-color, #2c3e50);
      margin: 0 0 1rem 0;
    }

    .chart-container {
      height: 300px;
      position: relative;
    }

    .models-table {
      background: white;
      border-radius: 8px;
      padding: 1.5rem;
      box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      border: 1px solid var(--border-color, #e9ecef);
      margin-bottom: 2rem;
    }

    .table-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th {
      text-align: left;
      padding: 0.75rem;
      font-weight: 600;
      color: var(--secondary-color, #6c757d);
      border-bottom: 2px solid var(--border-color, #e9ecef);
      font-size: 0.875rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    td {
      padding: 0.75rem;
      border-bottom: 1px solid var(--border-color, #e9ecef);
    }

    tr:hover {
      background: var(--hover-bg, #f8f9fa);
    }

    .model-name {
      font-weight: 500;
      color: var(--primary-color, #2c3e50);
    }

    .model-provider {
      font-size: 0.75rem;
      color: var(--secondary-color, #6c757d);
      background: var(--tag-bg, #e9ecef);
      padding: 0.125rem 0.5rem;
      border-radius: 12px;
      display: inline-block;
    }

    .token-count {
      font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
      font-weight: 600;
    }

    .cost-value {
      font-weight: 600;
      color: var(--primary-color, #2c3e50);
    }

    .percentage-bar {
      height: 6px;
      background: var(--border-color, #e9ecef);
      border-radius: 3px;
      overflow: hidden;
      margin-top: 0.25rem;
    }

    .percentage-fill {
      height: 100%;
      background: var(--primary-color, #2c3e50);
      border-radius: 3px;
    }

    .loading {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 3rem;
      color: var(--secondary-color, #6c757d);
    }

    .loading-spinner {
      width: 40px;
      height: 40px;
      border: 3px solid var(--border-color, #e9ecef);
      border-top-color: var(--primary-color, #2c3e50);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-bottom: 1rem;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .error {
      background: var(--error-bg, #f8d7da);
      border: 1px solid var(--error-border, #f5c6cb);
      color: var(--error-color, #721c24);
      padding: 1rem;
      border-radius: 4px;
      margin: 1rem 0;
    }

    .refresh-button {
      padding: 0.5rem 1rem;
      background: var(--primary-color, #2c3e50);
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.875rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      transition: background 0.2s;
    }

    .refresh-button:hover {
      background: var(--primary-dark, #1a252f);
    }

    .last-updated {
      font-size: 0.75rem;
      color: var(--secondary-color, #6c757d);
      margin-top: 0.5rem;
    }
  `;

  @property({ type: String })
  apiBaseUrl = '/api/v1/usage/token';

  @state()
  private loading = true;

  @state()
  private error: string | null = null;

  @state()
  private period: 'today' | 'week' | 'month' | 'year' = 'today';

  @state()
  private summaryData: any = null;

  @state()
  private modelRankings: any[] = [];

  @state()
  private usageTrend: any = null;

  @state()
  private lastUpdated: Date | null = null;

  connectedCallback() {
    super.connectedCallback();
    this.loadData();
  }

  async loadData() {
    this.loading = true;
    this.error = null;

    try {
      // 并行加载所有数据
      const [summaryResponse, rankingsResponse, trendResponse] = await Promise.all([
        this.fetchData(`${this.apiBaseUrl}/summary?period=30d`),
        this.fetchData(`${this.apiBaseUrl}/models/rankings?limit=10`),
        this.fetchData(`${this.apiBaseUrl}/trend?days=30`)
      ]);

      if (summaryResponse.success) {
        this.summaryData = summaryResponse.data;
      }

      if (rankingsResponse.success) {
        this.modelRankings = rankingsResponse.data;
      }

      if (trendResponse.success) {
        this.usageTrend = trendResponse.data;
      }

      this.lastUpdated = new Date();
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to load data';
      console.error('Failed to load token usage data:', err);
    } finally {
      this.loading = false;
    }
  }

  async fetchData(url: string) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  formatNumber(num: number): string {
    if (num >= 1000000) {
      return (num / 1000000).toFixed(1) + 'M';
    }
    if (num >= 1000) {
      return (num / 1000).toFixed(1) + 'K';
    }
    return num.toLocaleString();
  }

  formatCost(cost: number): string {
    return '$' + cost.toFixed(2);
  }

  formatPercentage(value: number): string {
    return value.toFixed(1) + '%';
  }

  formatDate(date: Date): string {
    return date.toLocaleTimeString([], { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: false 
    });
  }

  render() {
    if (this.loading) {
      return html`
        <div class="dashboard">
          <div class="loading">
            <div class="loading-spinner"></div>
            <div>Loading token usage data...</div>
          </div>
        </div>
      `;
    }

    if (this.error) {
      return html`
        <div class="dashboard">
          <div class="error">
            <strong>Error loading data:</strong> ${this.error}
            <button class="refresh-button" @click=${this.loadData}>
              Retry
            </button>
          </div>
        </div>
      `;
    }

    return html`
      <div class="dashboard">
        <!-- Header -->
        <div class="dashboard-header">
          <div>
            <h1 class="dashboard-title">Token Usage Dashboard</h1>
            <div class="dashboard-subtitle">
              Monitor AI token consumption and costs
            </div>
          </div>
          <div class="period-selector">
            <button 
              class="period-button ${this.period === 'today' ? 'active' : ''}"
              @click=${() => this.period = 'today'}
            >
              Today
            </button>
            <button 
              class="period-button ${this.period === 'week' ? 'active' : ''}"
              @click=${() => this.period = 'week'}
            >
              Week
            </button>
            <button 
              class="period-button ${this.period === 'month' ? 'active' : ''}"
              @click=${() => this.period = 'month'}
            >
              Month
            </button>
            <button 
              class="period-button ${this.period === 'year' ? 'active' : ''}"
              @click=${() => this.period = 'year'}
            >
              Year
            </button>
            <button class="refresh-button" @click=${this.loadData}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
              Refresh
            </button>
          </div>
        </div>

        <!-- Stats Grid -->
        <div class="stats-grid">
          ${this.renderStatCard(
            'Today\'s Tokens',
            this.summaryData?.today?.totalTokens || 0,
            'tokens',
            this.summaryData?.period?.growthRate || 0,
            'token-count'
          )}
          ${this.renderStatCard(
            'Today\'s Cost',
            this.summaryData?.today?.estimatedCost || 0,
            'cost',
            0,
            'cost-value'
          )}
          ${this.renderStatCard(
            'Avg Daily Tokens',
            this.summaryData?.period?.averageDailyTokens || 0,
            'average',
            0,
            'token-count'
          )}
          ${this.renderStatCard(
            'Total Models Used',
            this.summaryData?.today?.modelCount || 0,
            'models',
            0
          )}
        </div>

        <!-- Charts Section -->
        <div class="charts-section">
          <div class="chart-card">
            <h3 class="chart-title">Token Usage Trend</h3>
            <div class="chart-container">
              ${this.renderTrendChart()}
            </div>
          </div>
          <div class="chart-card">
            <h3 class="chart-title">Top Models Distribution</h3>
            <div class="chart-container">
              ${this.renderModelDistribution()}
            </div>
          </div>
        </div>

        <!-- Models Table -->
        <div class="models-table">
          <div class="table-header">
            <h3 class="chart-title">Top AI Models by Token Usage</h3>
            <div class="last-updated">
              Last updated: ${this.lastUpdated ? this.formatDate(this.lastUpdated) : 'Never'}
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Model</th>
                <th>Provider</th>
                <th>Tokens</th>
                <th>Cost</th>
                <th>Usage %</th>
              </tr>
            </thead>
            <tbody>
              ${repeat(
                this.modelRankings,
                (model, index) => html`
                  <tr>
                    <td>${index + 1}</td>
                    <td>
                      <div class="model-name">${model.model}</div>
                    </td>
                    <td>
                      <span class="model-provider">${model.provider}</span>
                    </td>
                    <td class="token-count">${this.formatNumber(model.totalTokens)}</td>
                    <td class="cost-value">${this.formatCost(model.estimatedCost)}</td>
                    <td>
                      ${this.formatPercentage(model.percentage || 0)}
                      <div class="percentage-bar">
                        <div class="percentage-fill" style="width: ${model.percentage ||