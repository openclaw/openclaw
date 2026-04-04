import fs from "node:fs";
import path from "node:path";
import { onAgentEvent, type AgentEventPayload } from "../infra/agent-events.js";
import { onDiagnosticEvent, type DiagnosticEventPayload } from "../infra/diagnostic-events.js";

export type TurnFixtureEntry =
  | { kind: "agent"; event: AgentEventPayload }
  | { kind: "diagnostic"; event: DiagnosticEventPayload };

export type TurnFixture = {
  version: 1;
  recordedAt: string;
  entries: TurnFixtureEntry[];
};

/**
 * Records all agent and diagnostic events during an active turn into a JSON fixture.
 * Call `start()` before the turn; call `stop()` after to finalize and write the fixture.
 */
export class TurnRecorder {
  private entries: TurnFixtureEntry[] = [];
  private disposeAgent: (() => void) | null = null;
  private disposeDiag: (() => void) | null = null;
  private startedAt: string | null = null;

  start(): void {
    this.entries = [];
    this.startedAt = new Date().toISOString();
    this.disposeAgent = onAgentEvent((event) => {
      this.entries.push({ kind: "agent", event });
    });
    this.disposeDiag = onDiagnosticEvent((event) => {
      this.entries.push({ kind: "diagnostic", event });
    });
  }

  stop(): TurnFixture {
    this.disposeAgent?.();
    this.disposeDiag?.();
    this.disposeAgent = null;
    this.disposeDiag = null;
    const fixture: TurnFixture = {
      version: 1,
      recordedAt: this.startedAt ?? new Date().toISOString(),
      entries: [...this.entries],
    };
    this.entries = [];
    return fixture;
  }

  writeToFile(fixture: TurnFixture, outputDir: string, label?: string): string {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const slug = label ? `-${label.replace(/\s+/g, "-").toLowerCase()}` : "";
    const filename = `turn-fixture${slug}-${ts}.json`;
    const filePath = path.join(outputDir, filename);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(fixture, null, 2));
    return filePath;
  }
}
