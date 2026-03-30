/**
 * Error Boundary Component
 * 
 * 捕获渲染错误并提供友好的错误提示
 */

import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/**
 * 错误边界组件
 * 
 * 用法：
 * ```html
 * <error-boundary>
 *   <my-component></my-component>
 * </error-boundary>
 * ```
 */
@customElement('error-boundary')
export class ErrorBoundary extends LitElement {
  static styles = css`
    :host {
      display: block;
    }

    .error-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 200px;
      padding: 32px;
      background: var(--error-container, #fef2f2);
      border: 1px solid var(--error-border, #fecaca);
      border-radius: 8px;
      text-align: center;
    }

    .error-icon {
      font-size: 48px;
      margin-bottom: 16px;
    }

    .error-title {
      font-size: 18px;
      font-weight: 600;
      color: var(--error-color, #dc2626);
      margin-bottom: 8px;
    }

    .error-message {
      font-size: 14px;
      color: var(--error-text, #7f1d1d);
      margin-bottom: 16px;
      max-width: 400px;
    }

    .error-details {
      font-size: 12px;
      color: var(--error-muted, #991b1b);
      background: var(--error-bg, #fee2e2);
      padding: 12px;
      border-radius: 4px;
      margin-bottom: 16px;
      max-width: 100%;
      overflow: auto;
      font-family: monospace;
      text-align: left;
      max-height: 200px;
    }

    .error-actions {
      display: flex;
      gap: 12px;
    }

    .error-button {
      padding: 8px 16px;
      font-size: 14px;
      border-radius: 4px;
      border: none;
      cursor: pointer;
      transition: all 0.2s;
    }

    .error-button--primary {
      background: var(--error-color, #dc2626);
      color: white;
    }

    .error-button--primary:hover {
      background: var(--error-hover, #b91c1c);
    }

    .error-button--secondary {
      background: var(--surface, #f3f4f6);
      color: var(--text, #374151);
    }

    .error-button--secondary:hover {
      background: var(--surface-hover, #e5e7eb);
    }
  `;

  @property({ type: String })
  fallbackTitle = 'Something went wrong';

  @property({ type: String })
  fallbackMessage = 'An unexpected error occurred. Please try again.';

  @state()
  private hasError = false;

  @state()
  private error: Error | null = null;

  @state()
  private errorInfo: string | null = null;

  @state()
  private showDetails = false;

  /**
   * 捕获错误（从外部调用）
   */
  catchError(error: Error, errorInfo?: string) {
    this.hasError = true;
    this.error = error;
    this.errorInfo = errorInfo ?? null;

    // 记录错误
    console.error('[ErrorBoundary] Caught error:', error);
    if (errorInfo) {
      console.error('[ErrorBoundary] Component stack:', errorInfo);
    }
  }

  /**
   * 重试
   */
  retry() {
    this.hasError = false;
    this.error = null;
    this.errorInfo = null;
    this.showDetails = false;
  }

  /**
   * 复制错误信息
   */
  async copyError() {
    if (!this.error) return;

    const text = [
      `Error: ${this.error.message}`,
      `Stack: ${this.error.stack}`,
      this.errorInfo ? `Component: ${this.errorInfo}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');

    try {
      await navigator.clipboard.writeText(text);
      alert('Error details copied to clipboard');
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }

  render() {
    if (this.hasError) {
      return html`
        <div class="error-container">
          <div class="error-icon">⚠️</div>
          <div class="error-title">${this.fallbackTitle}</div>
          <div class="error-message">${this.fallbackMessage}</div>

          ${this.showDetails && this.error
            ? html`
                <pre class="error-details">${this.error.message}\n\n${this.error.stack ?? ''}</pre>
              `
            : null}

          <div class="error-actions">
            <button class="error-button error-button--primary" @click=${this.retry}>
              Try Again
            </button>
            ${this.error
              ? html`
                  <button class="error-button error-button--secondary" @click=${() => (this.showDetails = !this.showDetails)}>
                    ${this.showDetails ? 'Hide Details' : 'Show Details'}
                  </button>
                  <button class="error-button error-button--secondary" @click=${this.copyError}>
                    Copy Error
                  </button>
                `
              : null}
          </div>
        </div>
      `;
    }

    // 渲染子组件
    return html`<slot></slot>`;
  }
}

// ─────────────────────────────────────────────────────────────
// Error Boundary Helper Functions
// ─────────────────────────────────────────────────────────────

/**
 * 全局错误处理器
 */
export function setupGlobalErrorHandler() {
  // 处理未捕获的 Promise 错误
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[GlobalErrorHandler] Unhandled promise rejection:', event.reason);
    event.preventDefault();
  });

  // 处理全局错误
  window.addEventListener('error', (event) => {
    console.error('[GlobalErrorHandler] Uncaught error:', event.error);
  });
}

/**
 * 报告错误
 */
export function reportError(error: Error, context?: string) {
  console.error(`[ErrorReport] ${context ?? 'Unknown context'}:`, error);

  // 可以发送到错误监控服务
  // fetch('/api/errors', { method: 'POST', body: JSON.stringify({ error, context }) });
}

declare global {
  interface HTMLElementTagNameMap {
    'error-boundary': ErrorBoundary;
  }
}