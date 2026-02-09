/**
 * OpenClaw AGI - Shared Types
 *
 * Common types used across all AGI modules.
 *
 * @module agi/shared/types
 */

// ============================================================================
// AGENT TYPES
// ============================================================================

export type AgentMode = "coding" | "research" | "planning" | "reviewing" | "idle" | "learning";
export type UserPresence = "online" | "away" | "dnd" | "unknown";

export interface PersonalityProfile {
  communicationStyle: "professional" | "friendly" | "concise" | "verbose" | "technical";
  humor: boolean;
  emojis: boolean;
  verbosity: "minimal" | "normal" | "detailed";
  proactiveLevel: "none" | "low" | "medium" | "high";
}

export interface AgentIdentity {
  id: string;
  name: string;
  description?: string;
  createdAt: Date;
  lastActiveAt: Date;
  totalSessions: number;
  personality: PersonalityProfile;
}

export interface AttentionFocus {
  currentFile?: string;
  currentTask?: string;
  currentLine?: number;
  currentColumn?: number;
}

export interface CodebaseSnapshot {
  repository?: string;
  branch?: string;
  commit?: string;
  lastIndexedAt?: Date;
  fileCount?: number;
  knownEntities?: string[];
}

export interface Environment {
  cwd: string;
  shell: string;
  nodeVersion: string;
  platform: string;
  toolsAvailable: string[];
}

export interface AgentState {
  mode: AgentMode;
  userPresence: UserPresence;
  codebaseState: CodebaseSnapshot;
  environment: Environment;
  attentionFocus: AttentionFocus;
}

export interface AgentKernel {
  identity: AgentIdentity;
  state: AgentState;
}

// ============================================================================
// INTENT TYPES
// ============================================================================

export type IntentType =
  | "implement"
  | "fix"
  | "research"
  | "review"
  | "refactor"
  | "analyze"
  | "test"
  | "deploy"
  | "other";
export type IntentPriority = "critical" | "high" | "medium" | "low";
export type IntentStatus =
  | "pending"
  | "active"
  | "blocked"
  | "completed"
  | "abandoned"
  | "escalated";
export type StepStatus = "pending" | "in_progress" | "completed" | "blocked" | "failed" | "skipped";

export interface Intent {
  id: string;
  agentId: string;
  parentId?: string;
  type: IntentType;
  description: string;
  priority: IntentPriority;
  status: IntentStatus;
  estimatedTime: number;
  dependencies: string[];
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  blockedReason?: string;
  escalationReason?: string;
  metadata: Record<string, unknown>;
}

export interface Plan {
  id: string;
  intentId: string;
  steps: PlanStep[];
  currentStepIndex: number;
  status: "active" | "completed" | "failed" | "abandoned";
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface PlanStep {
  id: string;
  planId: string;
  index: number;
  description: string;
  status: StepStatus;
  estimatedTime: number;
  dependencies: string[];
  blockedReason?: string;
  startedAt?: Date;
  completedAt?: Date;
  result?: unknown;
  error?: string;
}

// ============================================================================
// WORKING MEMORY TYPES
// ============================================================================

export interface FileContext {
  path: string;
  content?: string;
  checksum: string;
  importantLines?: number[];
  notes?: string;
  lastAccessed: Date;
}

export interface ToolInvocation {
  id: string;
  tool: string;
  params: Record<string, unknown>;
  result?: unknown;
  error?: string;
  duration: number;
  timestamp: Date;
}

export interface Decision {
  id: string;
  context: string;
  what: string;
  why: string;
  alternatives?: string[];
  timestamp: Date;
}

export interface Thought {
  id: string;
  content: string;
  type: "reasoning" | "observation" | "hypothesis" | "conclusion";
  relatedTo?: string;
  timestamp: Date;
}

export interface Note {
  id: string;
  content: string;
  category?: string;
  priority: "low" | "medium" | "high";
  timestamp: Date;
}

export interface Reminder {
  id: string;
  content: string;
  dueAt?: Date;
  completed: boolean;
  createdAt: Date;
}

export interface ActiveIntent {
  id: string;
  description: string;
  type: IntentType | "other";
  priority: IntentPriority;
  status: IntentStatus;
  startedAt: Date;
  estimatedCompletion?: Date;
}

export interface ExecutionPlan {
  id: string;
  steps: ExecutionStep[];
  currentStepIndex: number;
  startedAt: Date;
}

export interface ExecutionStep {
  id: string;
  description: string;
  status: StepStatus;
  startedAt?: Date;
  completedAt?: Date;
  result?: unknown;
  error?: string;
}

export interface Progress {
  overallPercent: number;
  currentStep: string;
  itemsProcessed: number;
  itemsTotal: number;
  startedAt: Date;
  estimatedCompletion?: Date;
}

export interface WorkingMemoryState {
  sessionId: string;
  agentId: string;
  startedAt: Date;
  lastSavedAt?: Date;
  filesOpen: Map<string, FileContext>;
  toolsUsed: ToolInvocation[];
  decisions: Decision[];
  intent?: ActiveIntent;
  plan?: ExecutionPlan;
  progress?: Progress;
  thoughts: Thought[];
  notes: Note[];
  reminders: Reminder[];
}

// ============================================================================
// GRAPH MEMORY TYPES
// ============================================================================

export type EntityType =
  | "function"
  | "class"
  | "file"
  | "concept"
  | "decision"
  | "variable"
  | "module"
  | "api";
export type RelationType =
  | "calls"
  | "imports"
  | "depends_on"
  | "implements"
  | "extends"
  | "related_to"
  | "defines"
  | "uses";

export interface Entity {
  id: string;
  type: EntityType;
  name: string;
  description?: string;
  location?: CodeLocation;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CodeLocation {
  file: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface Relation {
  id: string;
  from: string;
  to: string;
  type: RelationType;
  strength: number;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface Path {
  nodes: Entity[];
  edges: Relation[];
  distance: number;
}

// ============================================================================
// EPISODIC MEMORY TYPES
// ============================================================================

export interface Session {
  id: string;
  agentId: string;
  startTime: Date;
  endTime?: Date;
  intent?: string;
  outcome: "success" | "failure" | "abandoned" | "ongoing";
  summary?: string;
  keyEvents: Event[];
}

export interface Event {
  id: string;
  sessionId: string;
  timestamp: Date;
  type: EventType;
  content: string;
  metadata?: Record<string, unknown>;
}

export type EventType =
  | "thought"
  | "action"
  | "decision"
  | "correction"
  | "completion"
  | "error"
  | "milestone";

export interface Episode {
  id: string;
  sessionId: string;
  startTime: Date;
  endTime: Date;
  summary: string;
  entities: string[];
  embedding?: number[];
}

// ============================================================================
// LEARNING TYPES
// ============================================================================

export interface LearnedPattern {
  id: string;
  pattern: string;
  context: string;
  confidence: number;
  usageCount: number;
  createdAt: Date;
  lastUsedAt: Date;
}

export interface Correction {
  id: string;
  mistake: string;
  correction: string;
  context: string;
  timestamp: Date;
}

export interface Preference {
  id: string;
  category: string;
  key: string;
  value: unknown;
  confidence: number;
  timestamp: Date;
}

// ============================================================================
// UTILITY TYPES
// ============================================================================

export interface Result<T, E = Error> {
  success: boolean;
  data?: T;
  error?: E;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface FilterOptions {
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDirection?: "asc" | "desc";
}
