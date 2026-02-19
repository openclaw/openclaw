import type {
  EvidenceConfig,
  EvidenceGate,
  VerificationResult,
  EvidenceGateType,
} from "./types.js";
import { BaseVerifier } from "./verifier.js";
import { LSPVerifier } from "./verifiers/lsp.js";
import { BuildVerifier } from "./verifiers/build.js";
import { TestVerifier } from "./verifiers/test.js";
import { CustomVerifier } from "./verifiers/custom.js";

export class EvidenceGateManager {
  private config: EvidenceConfig;
  private workspace: string;

  constructor(config: EvidenceConfig, workspace: string) {
    this.config = config;
    this.workspace = workspace;
  }

  updateConfig(config: Partial<EvidenceConfig>): void {
    this.config = { ...this.config, ...config };
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  async runAllGates(): Promise<VerificationResult[]> {
    if (!this.config.enabled) {
      return [];
    }

    const results: VerificationResult[] = [];
    const enabledGates = this.config.gates.filter((g) => g.enabled);

    const promises = enabledGates.map((gate) => this.runGate(gate));
    results.push(...(await Promise.all(promises)));

    return results;
  }

  async runGate(gate: EvidenceGate): Promise<VerificationResult> {
    const verifier = this.createVerifier(gate);
    return await verifier.verify();
  }

  validateResults(results: VerificationResult[]): {
    passed: boolean;
    failed: VerificationResult[];
    optional: VerificationResult[];
  } {
    const failed = results.filter((r) => !r.success);
    const optional = results.filter((r) => r.success || !this.isRequired(r.type));

    return {
      passed: failed.length === 0,
      failed,
      optional,
    };
  }

  private createVerifier(gate: EvidenceGate): BaseVerifier {
    switch (gate.type) {
      case "lsp":
        return new LSPVerifier(gate, this.workspace);
      case "build":
        return new BuildVerifier(gate, this.workspace);
      case "test":
        return new TestVerifier(gate, this.workspace);
      case "custom":
        if (!gate.command) {
          throw new Error("Custom gate requires a command");
        }
        return new CustomVerifier(gate, this.workspace);
      default:
        throw new Error(`Unknown gate type: ${gate.type}`);
    }
  }

  private isRequired(type: EvidenceGateType): boolean {
    const gate = this.config.gates.find((g) => g.type === type);
    return gate?.required ?? false;
  }
}
