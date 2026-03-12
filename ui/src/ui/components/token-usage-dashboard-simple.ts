// Token使用统计Dashboard - 简化版本
import { LitElement, html, css } from 'lit';
import { customElement, state } from 'lit/decorators.js';

@customElement('token-usage-dashboard-simple')
export class TokenUsageDashboardSimple extends LitElement {
  static styles = css`
    :host {
      display: block;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    
    .dashboard {
      padding: 2rem;
      max-width: 1200px;
      margin: 0 auto;
    }
    
    .header {
      text-align: center;
      margin-bottom: 2rem;
    }
    
    .title {
      font-size: 2rem;
      font-weight: 600;
      color: #2c3e50;
      margin: 0 0 0.5rem 0;
    }
    
    .subtitle {
      font-size: 1rem;
      color: #6c757d;
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
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      border: 1px solid #e9ecef;
    }
    
    .stat-title {
      font-size: 0.875rem;
      color: #6c757d;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 0.5rem;
    }
    
    .stat-value {
      font-size: 2rem;
      font-weight: 700;
      color: #2c3e50;
    }
    
    .loading {
      text-align: center;
      padding: 3rem;
      color: #6c757d;
    }
    
    .error {
      background: #f8d7da;
      border: 1px solid #f5c6cb;
      color: #721c24;
      padding: 1rem;
      border-radius: 4px;
      margin: 1rem 0;
    }
    
    .refresh-btn {
      background: #2c3e50;
      color: white;
      border: none;
      padding: 0.5rem 1rem;
      border-radius: 4px;
      cursor: pointer;
      margin-top: 1rem;
    }
    
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 1rem;
    }
    
    th, td {
      padding: 0.75rem;
      text-align: left;
      border-bottom: 1px solid #e9ecef;
    }
    
    th {
      font-weight: 600;
      color: #6c757d;
    }
  `;

  @state()
  private loading = true;

  @state()
  private error: string | null = null;

  @state()
  private summaryData: any = null;

  @state()
  private modelRankings: any[] = [];

  connectedCallback() {
    super.connectedCallback();
    this.loadData();
  }

  async loadData() {
    this.loading = true;
    this.error = null;

    try {
      const [summaryRes, rankingsRes] = await Promise.all([
        fetch('/api/v1/usage/token/summary?period=30d'),
        fetch('/api/v1/usage/token/models/rankings?limit=10')
      ]);

      if (!summaryRes.ok) throw new Error(`Summary API: ${summaryRes.status}`);
      if (!rankingsRes.ok) throw new Error(`Rankings API: ${rankingsRes.status}`);

      const summary = await summaryRes.json();
      const rankings = await rankingsRes.json();

      if (summary.success) this.summaryData = summary.data;
      if (rankings.success) this.modelRankings = rankings.data;

    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Failed to load data';
      console.error('Dashboard error:', err);
    } finally {
      this.loading = false;
    }
  }

  formatNumber(num: number): string {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toLocaleString();
  }

  formatCost(cost: number): string {
    return '$' + cost.toFixed(2);
  }

  render() {
    if (this.loading) {
      return html`
        <div class="dashboard">
          <div class="loading">Loading token usage data...</div>
        </div>
      `;
    }

    if (this.error) {
      return html`
        <div class="dashboard">
          <div class="error">
            Error: ${this.error}
            <button class="refresh-btn" @click=${this.loadData}>Retry</button>
          </div>
        </div>
      `;
    }

    return html`
      <div class="dashboard">
        <div class="header">
          <h1 class="title">Token Usage Dashboard</h1>
          <div class="subtitle">Monitor AI token consumption and costs</div>
        </div>

        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-title">Today's Tokens</div>
            <div class="stat-value">
              ${this.formatNumber(this.summaryData?.today?.totalTokens || 0)}
            </div>
          </div>
          
          <div class="stat-card">
            <div class="stat-title">Today's Cost</div>
            <div class="stat-value">
              ${this.formatCost(this.summaryData?.today?.estimatedCost || 0)}
            </div>
          </div>
          
          <div class="stat-card">
            <div class="stat-title">Avg Daily Tokens</div>
            <div class="stat-value">
              ${this.formatNumber(this.summaryData?.period?.averageDailyTokens || 0)}
            </div>
          </div>
          
          <div class="stat-card">
            <div class="stat-title">Models Used</div>
            <div class="stat-value">
              ${this.summaryData?.today?.modelCount || 0}
            </div>
          </div>
        </div>

        <div class="stat-card">
          <div class="stat-title">Top Models by Token Usage</div>
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Provider</th>
                <th>Tokens</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              ${this.modelRankings.map(model => html`
                <tr>
                  <td>${model.model}</td>
                  <td>${model.provider}</td>
                  <td>${this.formatNumber(model.totalTokens)}</td>
                  <td>${this.formatCost(model.estimatedCost)}</td>
                </tr>
              `)}
            </tbody>
          </table>
        </div>

        <div style="text-align: center; margin-top: 2rem;">
          <button class="refresh-btn" @click=${this.loadData}>
            Refresh Data
          </button>
          <div style="font-size: 0.75rem; color: #6c757d; margin-top: 0.5rem;">
            Data updates when you refresh
          </div>
        </div>
      </div>
    `;
  }
}