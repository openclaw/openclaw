/**
 * UPC Verification Dialog Component
 * Modal dialog for verifying UPC credentials before executing high-risk tasks
 * 
 * This component provides UI integration for the UPC verification flow.
 * It can be integrated into the control UI agents view.
 */

export interface UPCVerificationDialogState {
  isOpen: boolean;
  taskName: string;
  taskDescription?: string;
  input: string;
  error?: string;
  remainingAttempts?: number;
  isLoading: boolean;
  approvalId?: string;
}

export interface UPCVerificationDialogEvents {
  onVerify: (input: string) => Promise<void>;
  onCancel: () => void;
  onSuccess: () => void;
}

/**
 * Create UPC verification dialog state
 */
export function createUPCVerificationDialogState(
  taskName: string,
  taskDescription?: string,
  approvalId?: string,
): UPCVerificationDialogState {
  return {
    isOpen: true,
    taskName,
    taskDescription,
    input: "",
    error: undefined,
    remainingAttempts: undefined,
    isLoading: false,
    approvalId,
  };
}

/**
 * Update UPC dialog state on verification attempt
 */
export function updateUPCDialogAfterAttempt(
  state: UPCVerificationDialogState,
  result: {
    verified: boolean;
    error?: string;
    remainingAttempts?: number;
  },
): UPCVerificationDialogState {
  if (result.verified) {
    return {
      ...state,
      isOpen: false,
      error: undefined,
      input: "",
    };
  }

  return {
    ...state,
    error: result.error,
    remainingAttempts: result.remainingAttempts,
    input: "", // Clear input on failed attempt
  };
}

/**
 * Generate HTML for UPC verification modal
 * For integration into control UI
 */
export function renderUPCVerificationModal(state: UPCVerificationDialogState): string {
  if (!state.isOpen) {
    return "";
  }

  const remainingText = state.remainingAttempts
    ? `${state.remainingAttempts} attempt${state.remainingAttempts !== 1 ? "s" : ""} remaining`
    : "";

  const errorHtml = state.error
    ? `<div class="upc-error" role="alert">
        <div class="upc-error-message">${escapeHtml(state.error)}</div>
        ${remainingText ? `<div class="upc-error-remaining">${escapeHtml(remainingText)}</div>` : ""}
      </div>`
    : "";

  return `
    <div class="upc-modal-overlay" role="presentation">
      <div class="upc-modal" role="alertdialog" aria-modal="true" aria-labelledby="upc-modal-title">
        <div class="upc-modal-content">
          <h2 id="upc-modal-title" class="upc-modal-title">Security Verification Required</h2>
          
          <div class="upc-task-info">
            <p class="upc-task-name">Task: ${escapeHtml(state.taskName)}</p>
            ${state.taskDescription ? `<p class="upc-task-description">${escapeHtml(state.taskDescription)}</p>` : ""}
          </div>

          ${errorHtml}

          <div class="upc-input-group">
            <label for="upc-input" class="upc-input-label">
              Enter your UPC code word:
            </label>
            <input
              id="upc-input"
              type="password"
              class="upc-input"
              placeholder="Enter code word"
              value="${escapeHtml(state.input)}"
              ${state.isLoading ? "disabled" : ""}
              aria-describedby="${state.error ? "upc-error" : ""}"
            />
          </div>

          <div class="upc-modal-actions">
            <button
              class="upc-button upc-button-cancel"
              ${state.isLoading ? "disabled" : ""}
            >
              Cancel
            </button>
            <button
              class="upc-button upc-button-verify"
              ${state.isLoading ? "disabled" : ""}
            >
              ${state.isLoading ? "Verifying..." : "Verify"}
            </button>
          </div>

          <p class="upc-security-notice">
            Your UPC code word is required to protect against unauthorized access to high-risk operations.
          </p>
        </div>
      </div>
    </div>
  `;
}

/**
 * Generate CSS for UPC modal styling
 */
export function getUPCModalStyles(): string {
  return `
    .upc-modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-color: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
    }

    .upc-modal {
      background: white;
      border-radius: 8px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1);
      max-width: 450px;
      width: 90%;
      padding: 0;
      animation: upc-modal-enter 0.3s ease-out;
    }

    @keyframes upc-modal-enter {
      from {
        opacity: 0;
        transform: scale(0.95);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }

    .upc-modal-content {
      padding: 32px;
    }

    .upc-modal-title {
      font-size: 20px;
      font-weight: 600;
      margin: 0 0 16px 0;
      color: #1f2937;
    }

    .upc-task-info {
      background: #f3f4f6;
      border-left: 4px solid #3b82f6;
      padding: 12px;
      margin-bottom: 20px;
      border-radius: 4px;
    }

    .upc-task-name {
      font-weight: 500;
      color: #1f2937;
      margin: 0 0 4px 0;
      font-size: 14px;
    }

    .upc-task-description {
      color: #6b7280;
      margin: 0;
      font-size: 13px;
    }

    .upc-error {
      background: #fee2e2;
      border: 1px solid #fca5a5;
      border-radius: 4px;
      padding: 12px;
      margin-bottom: 16px;
    }

    .upc-error-message {
      color: #dc2626;
      font-weight: 500;
      font-size: 14px;
      margin: 0 0 4px 0;
    }

    .upc-error-remaining {
      color: #991b1b;
      font-size: 12px;
      margin: 0;
    }

    .upc-input-group {
      margin-bottom: 20px;
    }

    .upc-input-label {
      display: block;
      font-size: 14px;
      font-weight: 500;
      color: #1f2937;
      margin-bottom: 8px;
    }

    .upc-input {
      width: 100%;
      padding: 10px 12px;
      font-size: 14px;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      box-sizing: border-box;
      transition: border-color 0.2s;
    }

    .upc-input:focus {
      outline: none;
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
    }

    .upc-input:disabled {
      background-color: #f9fafb;
      color: #9ca3af;
      cursor: not-allowed;
    }

    .upc-modal-actions {
      display: flex;
      gap: 12px;
      justify-content: flex-end;
      margin-bottom: 16px;
    }

    .upc-button {
      padding: 10px 16px;
      font-size: 14px;
      font-weight: 500;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .upc-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .upc-button-cancel {
      background-color: #f3f4f6;
      color: #374151;
      border: 1px solid #d1d5db;
    }

    .upc-button-cancel:hover:not(:disabled) {
      background-color: #e5e7eb;
    }

    .upc-button-verify {
      background-color: #3b82f6;
      color: white;
    }

    .upc-button-verify:hover:not(:disabled) {
      background-color: #2563eb;
    }

    .upc-security-notice {
      font-size: 12px;
      color: #6b7280;
      margin: 0;
      line-height: 1.4;
    }

    @media (prefers-reduced-motion: reduce) {
      .upc-modal {
        animation: none;
      }
    }

    @media (max-width: 640px) {
      .upc-modal-overlay {
        padding: 16px;
      }

      .upc-modal {
        max-width: 100%;
      }

      .upc-modal-content {
        padding: 24px;
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
