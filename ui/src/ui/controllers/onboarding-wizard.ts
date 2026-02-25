import type { GatewayBrowserClient } from "../gateway.ts";
import type { WizardStep } from "../views/onboarding-wizard.ts";

export type OnboardingWizardState = {
  sessionId: string | null;
  currentStep: WizardStep | null;
  stepIndex: number;
  totalSteps: number;
  loading: boolean;
  error: string | null;
};

const TOTAL_STEPS = 9;

export class OnboardingWizardController {
  private state: OnboardingWizardState = {
    sessionId: null,
    currentStep: null,
    stepIndex: 0,
    totalSteps: TOTAL_STEPS,
    loading: false,
    error: null,
  };

  constructor(private gateway: GatewayBrowserClient) {}

  async start(): Promise<void> {
    this.state.loading = true;
    this.state.error = null;

    try {
      const result = await this.gateway.request<{
        sessionId: string;
        done: boolean;
        step?: any;
        status?: string;
        error?: string;
      }>("wizard.start", {
        mode: "local",
      });

      if (result.done || result.status === "error") {
        throw new Error(result.error || "Failed to start wizard");
      }

      this.state.sessionId = result.sessionId;
      this.state.currentStep = this.mapStep(result.step);
      this.state.stepIndex = 0;
    } catch (err) {
      this.state.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.state.loading = false;
    }
  }

  async next(answer: unknown): Promise<void> {
    if (!this.state.sessionId) {
      throw new Error("No active wizard session");
    }

    this.state.loading = true;
    this.state.error = null;

    try {
      const result = await this.gateway.request<{
        done: boolean;
        step?: any;
        status?: string;
        error?: string;
      }>("wizard.next", {
        sessionId: this.state.sessionId,
        answer: {
          stepId: this.state.currentStep?.id,
          value: answer,
        },
      });

      if (result.done || result.status === "error") {
        if (result.done) {
          // Wizard complete
          this.state.currentStep = null;
        } else {
          throw new Error(result.error || "Failed to proceed wizard");
        }
        return;
      }

      this.state.currentStep = this.mapStep(result.step);
      this.state.stepIndex++;
    } catch (err) {
      this.state.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.state.loading = false;
    }
  }

  async back(): Promise<void> {
    // Note: Back navigation would require backend support
    // For now, we'll just decrement the step index if possible
    if (this.state.stepIndex > 0) {
      this.state.stepIndex--;
    }
  }

  async cancel(): Promise<void> {
    if (!this.state.sessionId) {
      return;
    }

    try {
      await this.gateway.request("wizard.cancel", {
        sessionId: this.state.sessionId,
      });
    } catch (err) {
      // Ignore cancel errors
    }

    this.state.sessionId = null;
    this.state.currentStep = null;
    this.state.stepIndex = 0;
    this.state.error = null;
  }

  getState(): OnboardingWizardState {
    return { ...this.state };
  }

  private mapStep(step: any): WizardStep | null {
    if (!step) {
      return null;
    }

    return {
      id: step.id,
      type: step.type,
      title: step.title,
      message: step.message,
      options: step.options,
      initialValue: step.initialValue,
      placeholder: step.placeholder,
      sensitive: step.sensitive,
      icon: step.icon,
      logo: step.logo,
      validation: step.validation,
      items: step.items,
      summary: step.summary,
    };
  }
}
