/**
 * Encoder Module — V component from Ha & Schmidhuber's World Models (2018)
 *
 * Compresses high-dimensional state/action observations into compact latent vectors.
 * Unlike the original VAE over pixel frames, we encode text-based agent state
 * (messages, tool calls, context) into fixed-size vectors using learned embeddings.
 *
 * Architecture:
 *   Raw State/Action → Token Hashing → Embedding Lookup → Mean Pooling → z ∈ ℝ^latentDim
 *
 * This is intentionally lightweight — no external ML dependencies.
 * The embeddings are learned during dream training via backprop through the LSTM.
 */

import type { WorldModelState, WorldModelAction } from "./types.js";

/** Known action types mapped to indices for one-hot-ish encoding */
const ACTION_TYPE_MAP: Record<string, number> = {
  text: 0,
  tool_call: 1,
  message_start: 2,
  message_end: 3,
  tool_execution_end: 4,
};

export class StateActionEncoder {
  /** Embedding table: vocabSize × latentDim */
  embeddings: Float64Array;
  /** Action type embedding: numActionTypes × latentDim */
  actionTypeEmbeddings: Float64Array;
  readonly vocabSize: number;
  readonly latentDim: number;
  readonly numActionTypes = 5;

  constructor(vocabSize: number = 4096, latentDim: number = 128) {
    this.vocabSize = vocabSize;
    this.latentDim = latentDim;

    // Xavier initialization for embeddings
    const scale = Math.sqrt(2.0 / (vocabSize + latentDim));
    this.embeddings = new Float64Array(vocabSize * latentDim);
    for (let i = 0; i < this.embeddings.length; i++) {
      this.embeddings[i] = (Math.random() * 2 - 1) * scale;
    }

    const actionScale = Math.sqrt(2.0 / (this.numActionTypes + latentDim));
    this.actionTypeEmbeddings = new Float64Array(this.numActionTypes * latentDim);
    for (let i = 0; i < this.actionTypeEmbeddings.length; i++) {
      this.actionTypeEmbeddings[i] = (Math.random() * 2 - 1) * actionScale;
    }
  }

  /**
   * Hash a string token into a vocabulary index using FNV-1a.
   * Collisions are expected and acceptable — the embeddings learn to handle them.
   */
  private hashToken(token: string): number {
    let hash = 0x811c9dc5; // FNV offset basis
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193); // FNV prime
    }
    return Math.abs(hash) % this.vocabSize;
  }

  /** Tokenize text into simple word-level tokens */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[\s\W]+/)
      .filter((t) => t.length > 0);
  }

  /** Look up embedding vector for a vocab index */
  private getEmbedding(index: number): Float64Array {
    const offset = index * this.latentDim;
    return this.embeddings.slice(offset, offset + this.latentDim);
  }

  /** Get action type embedding */
  private getActionTypeEmb(actionType: string): Float64Array {
    const idx = ACTION_TYPE_MAP[actionType] ?? 0;
    const offset = idx * this.latentDim;
    return this.actionTypeEmbeddings.slice(offset, offset + this.latentDim);
  }

  /**
   * Encode a WorldModelState into a latent vector z ∈ ℝ^latentDim.
   * Uses mean pooling over token embeddings from context + messages.
   */
  encodeState(state: WorldModelState): Float64Array {
    const z = new Float64Array(this.latentDim);
    let count = 0;

    // Encode context text
    if (state.context) {
      const tokens = this.tokenize(state.context);
      for (const token of tokens) {
        const emb = this.getEmbedding(this.hashToken(token));
        for (let d = 0; d < this.latentDim; d++) {
          z[d] += emb[d];
        }
        count++;
      }
    }

    // Encode recent messages
    if (state.messages) {
      const recent = state.messages.slice(-5); // Last 5 messages
      for (const msg of recent) {
        const text = typeof msg === "string" ? msg : ((msg as any).content ?? JSON.stringify(msg));
        const tokens = this.tokenize(String(text));
        for (const token of tokens) {
          const emb = this.getEmbedding(this.hashToken(token));
          for (let d = 0; d < this.latentDim; d++) {
            z[d] += emb[d];
          }
          count++;
        }
      }
    }

    // Mean pool
    if (count > 0) {
      for (let d = 0; d < this.latentDim; d++) {
        z[d] /= count;
      }
    }
    return z;
  }

  /**
   * Encode a WorldModelAction into a latent vector a ∈ ℝ^latentDim.
   * Combines action type embedding + hashed tool name/content.
   */
  encodeAction(action: WorldModelAction): Float64Array {
    const a = this.getActionTypeEmb(action.type).slice(); // Clone

    // Add tool name embedding if present
    if (action.toolName) {
      const toolEmb = this.getEmbedding(this.hashToken(action.toolName));
      for (let d = 0; d < this.latentDim; d++) {
        a[d] += toolEmb[d] * 0.5;
      }
    }

    // Add content embedding if present
    if (action.content) {
      const text =
        typeof action.content === "string" ? action.content : JSON.stringify(action.content);
      const tokens = this.tokenize(text).slice(0, 20); // Cap at 20 tokens
      if (tokens.length > 0) {
        for (const token of tokens) {
          const emb = this.getEmbedding(this.hashToken(token));
          for (let d = 0; d < this.latentDim; d++) {
            a[d] += (emb[d] / tokens.length) * 0.3;
          }
        }
      }
    }

    return a;
  }

  /**
   * Decode a latent vector back to the most likely action type and tool name.
   * Uses cosine similarity against action type embeddings and tool name candidates.
   */
  decodeAction(
    z: Float64Array,
    toolCandidates: string[],
  ): { type: string; toolName?: string; confidence: number } {
    // Find closest action type
    let bestType = "text";
    let bestTypeSim = -Infinity;
    for (const [typeName] of Object.entries(ACTION_TYPE_MAP)) {
      const emb = this.getActionTypeEmb(typeName);
      const sim = cosine(z, emb);
      if (sim > bestTypeSim) {
        bestTypeSim = sim;
        bestType = typeName;
      }
    }

    // Find closest tool name by comparing z against the composite
    // encoding (actionTypeEmb + 0.5 * toolEmb) for each candidate.
    let bestTool: string | undefined;
    let bestToolSim = -Infinity;
    if (bestType === "tool_call" && toolCandidates.length > 0) {
      const typeEmb = this.getActionTypeEmb("tool_call");
      for (const tool of toolCandidates) {
        const toolEmb = this.getEmbedding(this.hashToken(tool));
        const composite = new Float64Array(this.latentDim);
        for (let d = 0; d < this.latentDim; d++) {
          composite[d] = typeEmb[d] + toolEmb[d] * 0.5;
        }
        const sim = cosine(z, composite);
        if (sim > bestToolSim) {
          bestToolSim = sim;
          bestTool = tool;
        }
      }
    }

    // Confidence = average similarity, normalized to 0-1
    const rawConf = (bestTypeSim + (bestTool ? bestToolSim : 0)) / (bestTool ? 2 : 1);
    const confidence = Math.max(0, Math.min(1, (rawConf + 1) / 2));

    return { type: bestType, toolName: bestTool, confidence };
  }

  /** Serialize encoder weights for persistence */
  serialize(): {
    embeddings: number[];
    actionTypeEmbeddings: number[];
    vocabSize: number;
    latentDim: number;
  } {
    return {
      embeddings: Array.from(this.embeddings),
      actionTypeEmbeddings: Array.from(this.actionTypeEmbeddings),
      vocabSize: this.vocabSize,
      latentDim: this.latentDim,
    };
  }

  /** Load encoder weights from serialized data */
  static deserialize(data: {
    embeddings: number[];
    actionTypeEmbeddings: number[];
    vocabSize: number;
    latentDim: number;
  }): StateActionEncoder {
    const encoder = new StateActionEncoder(data.vocabSize, data.latentDim);
    encoder.embeddings = new Float64Array(data.embeddings);
    encoder.actionTypeEmbeddings = new Float64Array(data.actionTypeEmbeddings);
    return encoder;
  }
}

/** Cosine similarity between two vectors */
function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}
