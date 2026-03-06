/**
 * UPC Settings Panel Component
 * Configuration panel for managing UPC security settings
 * 
 * This component provides UI for:
 * - Enabling/disabling UPC protection
 * - Setting/updating UPC credentials
 * - Viewing UPC status
 */

export interface UPCSettingsState {
  enabled: boolean;
  hasUPC: boolean;
  isLocked: boolean;
  showSetForm: boolean;
  credential: string;
  credentialConfirm: string;
  error?: string;
  success?: string;
  isLoading: boolean;
}

/**
 * Create initial UPC settings state
 */
export function createUPCSettingsState(): UPCSettingsState {
  return {
    enabled: false,
    hasUPC: false,
    isLocked: false,
    showSetForm: false,
    credential: "",
    credentialConfirm: "",
    error: undefined,
    success: undefined,
    isLoading: false,
  };
}

/**
 * Validate UPC credential
 */
export function validateUPCCredential(credential: string): { valid: boolean; error?: string } {
  if (!credential || credential.trim().length === 0) {
    return { valid: false, error: "UPC code word cannot be empty" };
  }
  if (credential.length < 4) {
    return { valid: false, error: "UPC code word must be at least 4 characters" };
  }
  if (credential.length > 256) {
    return { valid: false, error: "UPC code word cannot exceed 256 characters" };
  }
  return { valid: true };
}

/**
 * Generate HTML for UPC settings panel
 */
export function renderUPCSettingsPanel(state: UPCSettingsState): string {
  return `
    <div class="upc-settings-panel">
      <div class="upc-settings-header">
        <h3 class="upc-settings-title">Private UPC Protection</h3>
        <p class="upc-settings-description">
          Require a code word to execute high-risk operations like file system changes,
          process execution, and gateway control.
        </p>
      </div>

      <div class="upc-settings-status">
        ${renderUPCStatusBadge(state)}
      </div>

      ${state.error ? `<div class="upc-settings-error" role="alert">${escapeHtml(state.error)}</div>` : ""}
      ${state.success ? `<div class="upc-settings-success" role="status">${escapeHtml(state.success)}</div>` : ""}

      <div class="upc-settings-content">
        ${!state.hasUPC ? renderSetUPCForm(state) : renderUPCManagement(state)}
      </div>
    </div>
  `;
}

/**
 * Render UPC status badge
 */
function renderUPCStatusBadge(state: UPCSettingsState): string {
  if (!state.enabled) {
    return `
      <div class="upc-status-badge upc-status-disabled">
        <span class="upc-status-icon">⊘</span>
        <span class="upc-status-label">UPC Protection Disabled</span>
      </div>
    `;
  }

  if (state.isLocked) {
    return `
      <div class="upc-status-badge upc-status-locked">
        <span class="upc-status-icon">🔒</span>
        <span class="upc-status-label">Account Locked (Too Many Failed Attempts)</span>
      </div>
    `;
  }

  return `
    <div class="upc-status-badge upc-status-enabled">
      <span class="upc-status-icon">✓</span>
      <span class="upc-status-label">UPC Protection Active</span>
    </div>
  `;
}

/**
 * Render form to set initial UPC
 */
function renderSetUPCForm(state: UPCSettingsState): string {
  return `
    <div class="upc-form-section">
      <div class="upc-form-group">
        <label for="upc-credential" class="upc-form-label">
          Code Word
        </label>
        <input
          id="upc-credential"
          type="password"
          class="upc-form-input"
          placeholder="Enter a code word (4-256 characters)"
          value="${escapeHtml(state.credential)}"
          ${state.isLoading ? "disabled" : ""}
          aria-describedby="upc-credential-hint"
        />
        <p id="upc-credential-hint" class="upc-form-hint">
          Use a memorable code word. You'll need this to perform high-risk operations.
        </p>
      </div>

      <div class="upc-form-group">
        <label for="upc-credential-confirm" class="upc-form-label">
          Confirm Code Word
        </label>
        <input
          id="upc-credential-confirm"
          type="password"
          class="upc-form-input"
          placeholder="Confirm code word"
          value="${escapeHtml(state.credentialConfirm)}"
          ${state.isLoading ? "disabled" : ""}
        />
      </div>

      <div class="upc-form-actions">
        <button
          class="upc-button upc-button-primary"
          ${state.isLoading ? "disabled" : ""}
        >
          ${state.isLoading ? "Saving..." : "Enable UPC Protection"}
        </button>
      </div>

      <div class="upc-form-security-info">
        <p class="upc-security-title">Security Information:</p>
        <ul class="upc-security-list">
          <li>Your code word is hashed and never stored in plain text</li>
          <li>Applies to: exec, spawn, file operations, gateway control</li>
          <li>One code word per account</li>
          <li>Account locked after 5 failed attempts (15 minute cooldown)</li>
        </ul>
      </div>
    </div>
  `;
}

/**
 * Render UPC management controls (when UPC is already set)
 */
function renderUPCManagement(state: UPCSettingsState): string {
  return `
    <div class="upc-management-section">
      <div class="upc-management-info">
        <p class="upc-management-text">
          UPC protection is active. Your code word is hashed and securely stored.
        </p>
      </div>

      <div class="upc-management-actions">
        <button class="upc-button upc-button-secondary">
          Change Code Word
        </button>
        <button
          class="upc-button upc-button-danger"
          ${state.isLoading ? "disabled" : ""}
        >
          ${state.isLoading ? "Disabling..." : "Disable UPC Protection"}
        </button>
      </div>
    </div>
  `;
}

/**
 * Generate CSS for UPC settings panel
 */
export function getUPCSettingsPanelStyles(): string {
  return `
    .upc-settings-panel {
      background: white;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 24px;
      margin-bottom: 24px;
    }

    .upc-settings-header {
      margin-bottom: 24px;
    }

    .upc-settings-title {
      font-size: 18px;
      font-weight: 600;
      color: #1f2937;
      margin: 0 0 8px 0;
    }

    .upc-settings-description {
      font-size: 14px;
      color: #6b7280;
      margin: 0;
      line-height: 1.5;
    }

    .upc-settings-status {
      margin-bottom: 20px;
    }

    .upc-status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
    }

    .upc-status-disabled {
      background: #f3f4f6;
      color: #6b7280;
    }

    .upc-status-enabled {
      background: #dcfce7;
      color: #166534;
    }

    .upc-status-locked {
      background: #fee2e2;
      color: #991b1b;
    }

    .upc-status-icon {
      font-size: 16px;
    }

    .upc-status-label {
      font-size: 13px;
    }

    .upc-settings-error {
      background: #fee2e2;
      border: 1px solid #fca5a5;
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 16px;
      color: #dc2626;
      font-size: 14px;
      role: alert;
    }

    .upc-settings-success {
      background: #dcfce7;
      border: 1px solid #86efac;
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 16px;
      color: #166534;
      font-size: 14px;
      role: status;
    }

    .upc-settings-content {
      margin-top: 20px;
    }

    .upc-form-section,
    .upc-management-section {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .upc-form-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .upc-form-label {
      font-size: 14px;
      font-weight: 500;
      color: #1f2937;
    }

    .upc-form-input {
      padding: 10px 12px;
      font-size: 14px;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      box-sizing: border-box;
      transition: border-color 0.2s;
    }

    .upc-form-input:focus {
      outline: none;
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
    }

    .upc-form-input:disabled {
      background-color: #f9fafb;
      color: #9ca3af;
      cursor: not-allowed;
    }

    .upc-form-hint {
      font-size: 12px;
      color: #6b7280;
      margin: 0;
    }

    .upc-form-actions {
      display: flex;
      gap: 12px;
      margin-top: 8px;
    }

    .upc-button {
      padding: 10px 16px;
      font-size: 14px;
      font-weight: 500;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
      white-space: nowrap;
    }

    .upc-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .upc-button-primary {
      background-color: #3b82f6;
      color: white;
    }

    .upc-button-primary:hover:not(:disabled) {
      background-color: #2563eb;
    }

    .upc-button-secondary {
      background-color: #f3f4f6;
      color: #374151;
      border: 1px solid #d1d5db;
    }

    .upc-button-secondary:hover:not(:disabled) {
      background-color: #e5e7eb;
    }

    .upc-button-danger {
      background-color: #ef4444;
      color: white;
    }

    .upc-button-danger:hover:not(:disabled) {
      background-color: #dc2626;
    }

    .upc-form-security-info {
      background: #f0f9ff;
      border-left: 4px solid #3b82f6;
      padding: 12px;
      border-radius: 4px;
    }

    .upc-security-title {
      font-size: 12px;
      font-weight: 600;
      color: #1e40af;
      margin: 0 0 8px 0;
    }

    .upc-security-list {
      margin: 0;
      padding-left: 20px;
      font-size: 12px;
      color: #1e40af;
      line-height: 1.6;
    }

    .upc-security-list li {
      margin-bottom: 4px;
    }

    .upc-management-info {
      background: #f0fdf4;
      border-left: 4px solid #22c55e;
      padding: 12px;
      border-radius: 4px;
    }

    .upc-management-text {
      font-size: 14px;
      color: #166534;
      margin: 0;
    }

    .upc-management-actions {
      display: flex;
      gap: 12px;
    }

    @media (max-width: 640px) {
      .upc-settings-panel {
        padding: 16px;
      }

      .upc-button {
        flex: 1;
      }
    }
  `;
}

/**
 * Utility function to escape HTML special characters
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (char) => map[char]);
}
