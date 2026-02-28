/**
 * IBEL Phase 1 — Field-level taint tracking engine.
 *
 * Tracks which fields within an artifact are derived from untrusted sources.
 * Auto-collapses to full-artifact taint when field count exceeds the explosion
 * threshold (256 by default) to prevent unbounded memory growth in long sessions.
 */

import { InstructionLevel } from "./types.js";
import type { TaggedPayload, TaintField } from "./types.js";

const DEFAULT_EXPLOSION_THRESHOLD = 256;

export class TaintTracker {
  private fields = new Map<string, TaintField>();
  private aggregateLevel: InstructionLevel = InstructionLevel.SYSTEM;
  private collapsed = false;
  private readonly explosionThreshold: number;

  constructor(options?: { explosionThreshold?: number }) {
    this.explosionThreshold = options?.explosionThreshold ?? DEFAULT_EXPLOSION_THRESHOLD;
  }

  /**
   * Tag a single field with a taint level.
   * If the tracker has already collapsed, this is a no-op for field tracking
   * but still updates the aggregate level.
   */
  tagField(path: string, level: InstructionLevel, source?: string): void {
    this.updateAggregate(level);

    if (this.collapsed) {
      return;
    }

    const existing = this.fields.get(path);
    if (existing && existing.level >= level) {
      // Existing taint is already worse or equal — keep it.
      return;
    }

    this.fields.set(path, {
      fieldPath: path,
      level,
      source,
      taggedAt: Date.now(),
    });

    if (this.fields.size > this.explosionThreshold) {
      this.collapse();
    }
  }

  /**
   * Collapse to full-artifact taint. All field-level tracking is discarded;
   * the entire artifact is treated at the aggregate taint level.
   */
  tagArtifact(level: InstructionLevel): void {
    this.updateAggregate(level);
    this.collapse();
  }

  /**
   * Merge another tracker into this one (worst-case per field).
   */
  merge(other: TaintTracker): void {
    this.updateAggregate(other.aggregateLevel);

    if (this.collapsed) {
      return;
    }

    if (other.collapsed) {
      this.collapse();
      return;
    }

    for (const [path, field] of other.fields) {
      const existing = this.fields.get(path);
      if (!existing || field.level > existing.level) {
        this.fields.set(path, { ...field });
      }
    }

    if (this.fields.size > this.explosionThreshold) {
      this.collapse();
    }
  }

  /** Current worst-case taint level across all tracked fields. */
  getAggregateLevel(): InstructionLevel {
    return this.aggregateLevel;
  }

  /** Whether field-level tracking has been collapsed to artifact-level. */
  isCollapsed(): boolean {
    return this.collapsed;
  }

  /** Number of individually tracked fields (0 if collapsed). */
  fieldCount(): number {
    return this.collapsed ? 0 : this.fields.size;
  }

  /** Snapshot of all tracked fields (empty array if collapsed). */
  getFields(): TaintField[] {
    if (this.collapsed) {
      return [];
    }
    return [...this.fields.values()];
  }

  /** Get taint for a specific field path, or undefined if not tracked. */
  getFieldTaint(path: string): TaintField | undefined {
    if (this.collapsed) {
      return undefined;
    }
    return this.fields.get(path);
  }

  /**
   * Create a TaggedPayload snapshot for pipeline consumption.
   */
  toTaggedPayload(content: unknown, source?: string): TaggedPayload {
    return {
      level: this.aggregateLevel,
      content,
      source,
      fields: this.collapsed ? undefined : this.getFields(),
    };
  }

  private updateAggregate(level: InstructionLevel): void {
    if (level > this.aggregateLevel) {
      this.aggregateLevel = level;
    }
  }

  private collapse(): void {
    this.collapsed = true;
    this.fields.clear();
  }
}
