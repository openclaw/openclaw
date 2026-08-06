import type { SystemAgentChatResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { WizardStep } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  clearCustodianRecoveryForClient,
  reconcileCustodianRecoveryForClient,
} from "./custodian-recovery.ts";
import { initialCustodianWizardValue } from "./custodian-wizard-step.ts";
import type { CustodianStructuredQuestion } from "./structured-question.ts";
import {
  createCustodianSessionId,
  loadCustodianTranscriptSnapshot,
  type CustodianMessage,
  type CustodianTranscriptSnapshot,
} from "./transcript.ts";

export type CustodianTranscriptHistoryOutcome = "recovered" | "inactive" | "unavailable";

/** Transcript-owned state shared by live turns and reload recovery. */
export abstract class CustodianTranscriptState {
  messages: CustodianMessage[] = [];
  sensitive = false;
  wizardInputPending = false;
  wizardValue: unknown;
  wizardSecretVisible = false;
  questionReplyUncertain = false;
  earlierBoundaryAfterId: number | null = null;
  activeClient: GatewayBrowserClient | null = null;

  protected sessionId = createCustodianSessionId();
  protected nextMessageId = 1;
  protected requestEpoch = 0;
  protected sessionClient: GatewayBrowserClient | null = null;
  private sessionGatewayUrl: string | null = null;
  private lastHelloDeviceToken = "";

  protected abstract emit(): void;

  protected bindSessionRecovery(client: GatewayBrowserClient, gatewayUrl: string): void {
    this.sessionClient = client;
    this.sessionGatewayUrl = gatewayUrl;
  }

  protected currentSessionOwnershipKey(context: ApplicationContext | null): string {
    if (!context) {
      return "";
    }
    const { gatewayUrl, token, password, bootstrapToken } = context.gateway.connection;
    const auth = context.gateway.snapshot.hello?.auth;
    if (auth) {
      this.lastHelloDeviceToken = auth.deviceToken ?? "";
    }
    return JSON.stringify([gatewayUrl, token, password, bootstrapToken, this.lastHelloDeviceToken]);
  }

  protected clearRecovery(
    client: GatewayBrowserClient,
    gatewayUrl: string,
    expectedSessionId?: string,
  ): void {
    clearCustodianRecoveryForClient(client, gatewayUrl, expectedSessionId);
  }

  protected clearSessionRecovery(expectedSessionId = this.sessionId): void {
    if (!this.sessionClient || this.sessionGatewayUrl === null) {
      return;
    }
    this.clearRecovery(this.sessionClient, this.sessionGatewayUrl, expectedSessionId);
  }

  protected reconcileSessionRecovery(
    client: GatewayBrowserClient,
    gatewayUrl: string,
    result: SystemAgentChatResult,
    requestSessionId: string,
  ): void {
    reconcileCustodianRecoveryForClient(client, gatewayUrl, result, requestSessionId);
  }

  protected async refreshTranscriptHistory(
    client: GatewayBrowserClient,
    epoch: number,
    historySupported: boolean,
    sessionId?: string,
  ): Promise<CustodianTranscriptHistoryOutcome> {
    if (!historySupported) {
      return "inactive";
    }
    let transcript;
    try {
      transcript = await loadCustodianTranscriptSnapshot(client, this.nextMessageId, sessionId);
    } catch {
      return "unavailable";
    }
    if (epoch !== this.requestEpoch || client !== this.activeClient) {
      return "inactive";
    }
    const recovered = this.applyTranscriptSnapshot(transcript, sessionId);
    this.emit();
    return recovered ? "recovered" : "inactive";
  }

  protected appendAssistant(
    reply: string,
    question: CustodianStructuredQuestion | null,
    step: WizardStep | null,
  ): void {
    this.messages = [
      ...this.messages,
      {
        id: this.nextMessageId++,
        role: "assistant",
        text: reply,
        at: Date.now(),
        question,
        step,
      },
    ];
  }

  protected applyTranscriptSnapshot(
    transcript: CustodianTranscriptSnapshot,
    recoveredSessionId?: string,
  ): boolean {
    this.messages = transcript.messages;
    this.nextMessageId = transcript.nextMessageId;
    this.earlierBoundaryAfterId = transcript.earlierBoundaryAfterId;
    const step = transcript.recoveredStep;
    if (step && recoveredSessionId) {
      this.sessionId = recoveredSessionId;
      this.sensitive = step.sensitive === true;
      this.wizardInputPending = true;
      this.wizardValue = initialCustodianWizardValue(step);
      this.wizardSecretVisible = false;
      this.questionReplyUncertain = false;
    }
    return step !== undefined;
  }
}
