import {
  type Component,
  Input,
  isKeyRelease,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type SelectItem,
} from "@mariozechner/pi-tui";
import chalk from "chalk";
import { theme } from "../theme/theme.js";
import type { ChatLog } from "./chat-log.js";

const DEFAULT_BASE_URL = "https://api.example.com/v1";

// Color helpers
const palette = {
  text: "#E8E3D5",
  dim: "#7B7F87",
  accent: "#F6C453",
  accentSoft: "#F2A65A",
  border: "#3C414B",
  error: "#F97066",
  success: "#7DD3A5",
  info: "#8CC8FF",
};

const fg = (hex: string) => (text: string) => chalk.hex(hex)(text);

type CompatibilityMode = "openai" | "anthropic" | "auto";
type WizardStep =
  | "baseUrl"
  | "apiKey"
  | "compatibility"
  | "modelId"
  | "providerId"
  | "alias"
  | "shouldVerify"
  | "verify"
  | "done";

type WizardState = {
  step: WizardStep;
  baseUrl: string;
  apiKey: string;
  compatibility: CompatibilityMode;
  modelId: string;
  providerId: string;
  alias: string;
  error?: string;
  verifying?: boolean;
  skipVerify?: boolean;
};

const COMPATIBILITY_OPTIONS: Array<SelectItem & { value: CompatibilityMode }> = [
  { value: "auto", label: "Auto-detect", description: "Probe both OpenAI and Anthropic endpoints" },
  { value: "openai", label: "OpenAI-compatible", description: "Uses /chat/completions" },
  { value: "anthropic", label: "Anthropic-compatible", description: "Uses /messages" },
];

const YES_NO_OPTIONS: Array<SelectItem & { value: string }> = [
  { value: "yes", label: "Yes", description: "Verify endpoint before adding (recommended)" },
  { value: "no", label: "No", description: "Skip verification and add directly" },
];

export class AddProviderWizard implements Component {
  private state: WizardState;
  private input: Input;
  private chatLog: ChatLog;
  public onSelect?: (result: {
    baseUrl: string;
    apiKey: string;
    api: "openai-completions" | "anthropic-messages";
    providerId: string;
    modelId: string;
    alias: string;
  }) => void;
  public onCancel?: () => void;
  private selectedIndex = 0;

  constructor(chatLog: ChatLog) {
    this.chatLog = chatLog;
    this.input = new Input();
    this.state = {
      step: "baseUrl",
      baseUrl: "",
      apiKey: "",
      compatibility: "auto",
      modelId: "",
      providerId: "",
      alias: "",
    };
  }

  invalidate(): void {
    this.input.invalidate();
  }

  private formatPrompt(): string {
    const prompts: Record<WizardStep, string> = {
      baseUrl: "API Base URL",
      apiKey: "API Key (optional, press Enter to skip)",
      compatibility: "Endpoint Compatibility",
      modelId: "Model ID",
      providerId: "Provider ID",
      alias: "Model Alias (optional, press Enter to skip)",
      shouldVerify: "Verify endpoint?",
      verify: "Verifying...",
      done: "Done",
    };
    return prompts[this.state.step] || "";
  }

  private formatPlaceholder(): string {
    const placeholders: Record<WizardStep, string> = {
      baseUrl: DEFAULT_BASE_URL,
      apiKey: "sk-...",
      compatibility: "",
      modelId: "e.g. gpt-4, claude-3-sonnet",
      providerId: "auto-generated from URL",
      alias: "e.g. local, ollama, my-model",
      shouldVerify: "",
      verify: "",
      done: "",
    };
    return placeholders[this.state.step] || "";
  }

  private getStepNumber(): number {
    const steps: WizardStep[] = [
      "baseUrl",
      "apiKey",
      "compatibility",
      "modelId",
      "providerId",
      "alias",
      "shouldVerify",
    ];
    return steps.indexOf(this.state.step) + 1;
  }

  private getTotalSteps(): number {
    return 7;
  }

  private validateUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  private generateProviderId(): string {
    try {
      const url = new URL(this.state.baseUrl);
      const host = url.hostname.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      const port = url.port ? `-${url.port}` : "";
      return `custom-${host}${port}`;
    } catch {
      return "custom";
    }
  }

  private renderStep(width: number): string[] {
    const lines: string[] = [];

    // Header
    const borderChar = "─";
    const borderColor = fg(palette.border);
    lines.push(
      borderColor("┌") +
        borderColor("─ Add Custom Provider ".padEnd(48, borderChar)) +
        borderColor("┐"),
    );
    lines.push(
      fg(palette.dim)(
        `│ Step ${this.getStepNumber()}/${this.getTotalSteps()}: ${this.formatPrompt()}`.padEnd(54),
      ) + borderColor("│"),
    );
    lines.push(borderColor("├") + borderColor("─".repeat(50)) + borderColor("┤"));

    // Current step content
    switch (this.state.step) {
      case "baseUrl":
      case "apiKey":
      case "modelId":
      case "providerId":
      case "alias":
        lines.push(this.renderInputStep(width));
        break;
      case "compatibility":
        lines.push(...this.renderCompatibilityStep(width));
        break;
      case "shouldVerify":
        lines.push(...this.renderShouldVerifyStep(width));
        break;
      case "verify":
        lines.push(
          `${borderColor("│")} ${fg(palette.info)("Verifying endpoint...").padEnd(53)}${borderColor("│")}`,
        );
        break;
      case "done":
        lines.push(
          `${borderColor("│")} ${fg(palette.success)("Provider added successfully!").padEnd(53)}${borderColor("│")}`,
        );
        break;
    }

    // Footer
    lines.push(borderColor("├") + borderColor("─".repeat(50)) + borderColor("┤"));
    lines.push(fg(palette.dim)("│ Enter: Next  Esc: Cancel  ↑↓: Navigate".padEnd(54) + "│"));
    lines.push(borderColor("└") + borderColor("─".repeat(50)) + borderColor("┘"));

    // Error message
    if (this.state.error) {
      lines.push("");
      lines.push(theme.error(`  Error: ${this.state.error}`));
    }

    return lines;
  }

  private renderInputStep(_width: number): string {
    const inputValue = this.input.getValue();
    const displayValue = inputValue || this.formatPlaceholder();
    const promptWidth = 52;
    const maxWidth = promptWidth - 2;

    let valueDisplay: string;
    if (inputValue) {
      valueDisplay = truncateToWidth(inputValue, maxWidth, "");
    } else {
      valueDisplay = fg(palette.dim)(truncateToWidth(displayValue, maxWidth, ""));
    }

    const prefix = "│ > ";
    const padding = " ".repeat(Math.max(0, maxWidth - visibleWidth(valueDisplay)));
    return `${prefix}${valueDisplay}${padding} ${fg(palette.border)("│")}`;
  }

  private renderCompatibilityStep(_width: number): string[] {
    const lines: string[] = [];
    for (let i = 0; i < COMPATIBILITY_OPTIONS.length; i++) {
      const option = COMPATIBILITY_OPTIONS[i];
      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? "│ → " : "│   ";
      const label = option.label.padEnd(20);
      const desc = option.description || "";
      const maxDescWidth = 28;
      const truncatedDesc = truncateToWidth(desc, maxDescWidth, "…");
      const line = isSelected
        ? `${prefix}${fg(palette.accent)(label)}${fg(palette.dim)(truncatedDesc).padEnd(maxDescWidth)} ${fg(palette.border)("│")}`
        : `${prefix}${label}${fg(palette.dim)(truncatedDesc).padEnd(maxDescWidth)} ${fg(palette.border)("│")}`;
      lines.push(line);
    }
    return lines;
  }

  private renderShouldVerifyStep(_width: number): string[] {
    const lines: string[] = [];
    lines.push(
      `${fg(palette.border)("│")} ${"Verify endpoint before adding?".padEnd(50)}${fg(palette.border)("│")}`,
    );
    lines.push(
      `${fg(palette.border)("│")} ${fg(palette.dim)("(Recommended for first-time setup)").padEnd(50)}${fg(palette.border)("│")}`,
    );
    lines.push(`${fg(palette.border)("│")} ${"".padEnd(50)}${fg(palette.border)("│")}`);
    for (let i = 0; i < YES_NO_OPTIONS.length; i++) {
      const option = YES_NO_OPTIONS[i];
      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? "│ → " : "│   ";
      const label = option.label.padEnd(15);
      const desc = option.description || "";
      const maxDescWidth = 33;
      const truncatedDesc = truncateToWidth(desc, maxDescWidth, "…");
      const line = isSelected
        ? `${prefix}${fg(palette.accent)(label)}${fg(palette.dim)(truncatedDesc).padEnd(maxDescWidth)} ${fg(palette.border)("│")}`
        : `${prefix}${label}${fg(palette.dim)(truncatedDesc).padEnd(maxDescWidth)} ${fg(palette.border)("│")}`;
      lines.push(line);
    }
    return lines;
  }

  render(width: number): string[] {
    return this.renderStep(width);
  }

  private async verifyEndpoint(): Promise<{
    ok: boolean;
    api?: "openai-completions" | "anthropic-messages";
    error?: string;
  }> {
    const { baseUrl, apiKey, modelId } = this.state;

    // Try OpenAI first
    try {
      const openaiEndpoint = new URL(
        "chat/completions",
        baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
      ).href;
      const res = await fetch(openaiEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: modelId || "test",
          messages: [{ role: "user", content: "Hi" }],
          max_tokens: 5,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        return { ok: true, api: "openai-completions" };
      }
    } catch {
      // Fall through to try Anthropic
    }

    // Try Anthropic
    try {
      const anthropicEndpoint = new URL("messages", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`)
        .href;
      const res = await fetch(anthropicEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          ...(apiKey ? { "x-api-key": apiKey } : {}),
        },
        body: JSON.stringify({
          model: modelId || "test",
          max_tokens: 16,
          messages: [{ role: "user", content: "Hi" }],
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        return { ok: true, api: "anthropic-messages" };
      }
    } catch {
      // Both failed
    }

    return {
      ok: false,
      error: "Could not verify endpoint. Please check URL, API key, and model ID.",
    };
  }

  private async nextStep(): Promise<void> {
    this.state.error = undefined;

    switch (this.state.step) {
      case "baseUrl": {
        const url = this.input.getValue().trim();
        if (!url) {
          this.state.error = "Base URL is required";
          return;
        }
        if (!this.validateUrl(url)) {
          this.state.error = "Invalid URL format";
          return;
        }
        this.state.baseUrl = url;
        this.input.setValue("");
        this.state.step = "apiKey";
        break;
      }

      case "apiKey":
        this.state.apiKey = this.input.getValue().trim();
        this.input.setValue("");
        this.state.step = "compatibility";
        break;

      case "compatibility":
        this.state.compatibility = COMPATIBILITY_OPTIONS[this.selectedIndex].value;
        this.state.step = "modelId";
        break;

      case "modelId": {
        const modelId = this.input.getValue().trim();
        if (!modelId) {
          this.state.error = "Model ID is required";
          return;
        }
        this.state.modelId = modelId;
        this.input.setValue("");

        // Auto-generate provider ID
        this.state.providerId = this.generateProviderId();
        this.state.step = "providerId";
        break;
      }

      case "providerId": {
        const providerId = this.input.getValue().trim();
        if (!providerId) {
          this.state.error = "Provider ID is required";
          return;
        }
        // Validate provider ID format
        if (!/^[a-z0-9-]+$/.test(providerId)) {
          this.state.error =
            "Provider ID must contain only lowercase letters, numbers, and hyphens";
          return;
        }
        this.state.providerId = providerId;
        this.input.setValue("");
        this.state.step = "alias";
        break;
      }

      case "alias": {
        this.state.alias = this.input.getValue().trim();
        this.input.setValue("");
        this.state.step = "shouldVerify";
        this.selectedIndex = 0; // Reset to first option (Yes)
        break;
      }

      case "shouldVerify": {
        const shouldVerify = YES_NO_OPTIONS[this.selectedIndex].value === "yes";
        this.state.skipVerify = !shouldVerify;

        if (!shouldVerify) {
          // Skip verification, complete directly
          const api =
            this.state.compatibility === "anthropic" ? "anthropic-messages" : "openai-completions";

          if (this.onSelect) {
            this.onSelect({
              baseUrl: this.state.baseUrl,
              apiKey: this.state.apiKey,
              api,
              providerId: this.state.providerId,
              modelId: this.state.modelId,
              alias: this.state.alias,
            });
          }
          this.state.step = "done";
          break;
        }

        // Verify endpoint before completing
        this.state.step = "verify";
        this.state.verifying = true;

        let api: "openai-completions" | "anthropic-messages" = "openai-completions";
        let verificationError: string | undefined;

        if (this.state.compatibility === "auto") {
          const result = await this.verifyEndpoint();
          if (result.ok && result.api) {
            api = result.api;
          } else {
            verificationError = result.error;
          }
        } else {
          api =
            this.state.compatibility === "anthropic" ? "anthropic-messages" : "openai-completions";
          const result = await this.verifyEndpoint();
          if (!result.ok) {
            verificationError = result.error;
          }
        }

        this.state.verifying = false;

        if (verificationError) {
          this.state.error = verificationError;
          this.state.step = "baseUrl"; // Go back to start
          this.input.setValue(this.state.baseUrl);
          return;
        }

        // Success! Complete the wizard
        if (this.onSelect) {
          this.onSelect({
            baseUrl: this.state.baseUrl,
            apiKey: this.state.apiKey,
            api,
            providerId: this.state.providerId,
            modelId: this.state.modelId,
            alias: this.state.alias,
          });
        }
        this.state.step = "done";
        break;
      }
    }
    // End of switch
  }

  private previousStep(): void {
    switch (this.state.step) {
      case "apiKey":
        this.state.step = "baseUrl";
        this.input.setValue(this.state.baseUrl);
        break;
      case "compatibility":
        this.state.step = "apiKey";
        this.input.setValue(this.state.apiKey);
        break;
      case "modelId":
        this.state.step = "compatibility";
        break;
      case "providerId":
        this.state.step = "modelId";
        this.input.setValue(this.state.modelId);
        break;
      case "alias":
        this.state.step = "providerId";
        this.input.setValue(this.state.providerId);
        break;
      case "shouldVerify":
        this.state.step = "alias";
        this.input.setValue(this.state.alias);
        break;
      case "verify":
        this.state.step = "alias";
        this.input.setValue(this.state.alias);
        break;
    }
    this.state.error = undefined;
  }

  public handleInput(keyData: string): void {
    if (isKeyRelease(keyData)) {
      return;
    }

    // Escape to cancel
    if (matchesKey(keyData, "escape")) {
      if (this.onCancel) {
        this.onCancel();
      }
      return;
    }

    if (this.state.step === "compatibility") {
      // Navigation in compatibility selection
      if (matchesKey(keyData, "up") || keyData === "k") {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        return;
      }
      if (matchesKey(keyData, "down") || keyData === "j") {
        this.selectedIndex = Math.min(COMPATIBILITY_OPTIONS.length - 1, this.selectedIndex + 1);
        return;
      }
      if (matchesKey(keyData, "enter")) {
        void this.nextStep();
        return;
      }
      return;
    }

    if (this.state.step === "shouldVerify") {
      // Navigation in yes/no selection
      if (matchesKey(keyData, "up") || keyData === "k") {
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        return;
      }
      if (matchesKey(keyData, "down") || keyData === "j") {
        this.selectedIndex = Math.min(YES_NO_OPTIONS.length - 1, this.selectedIndex + 1);
        return;
      }
      if (matchesKey(keyData, "enter")) {
        void this.nextStep();
        return;
      }
      return;
    }

    // Handle input steps
    if (matchesKey(keyData, "enter")) {
      void this.nextStep();
      return;
    }

    // Backspace to go back in input mode
    if (
      keyData === "backspace" &&
      this.input.getValue().length === 0 &&
      this.state.step !== "baseUrl"
    ) {
      this.previousStep();
      return;
    }

    // Pass other keys to input
    this.input.handleInput(keyData);
  }
}
