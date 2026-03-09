# Workflow Nodes Architecture

## Overview

Each workflow node type is implemented as a separate module with a standardized interface.

## Node Interface

```typescript
interface WorkflowNodeHandler {
  /**
   * Unique action type identifier
   */
  actionType: string;

  /**
   * Execute the node
   * @param input - Node configuration and input data
   * @param context - Execution context (previous outputs, variables, etc.)
   * @returns Execution result with output for next node
   */
  execute(input: NodeInput, context: ExecutionContext): Promise<NodeOutput>;
}
```

## Node Input Structure

```typescript
interface NodeInput {
  // Common fields
  nodeId: string;
  label: string;
  actionType: string;

  // Data from previous node in chain
  previousOutput?: string;

  // Node-specific configuration (varies by node type)
  config: Record<string, unknown>;

  // Workflow-level variables
  variables: Map<string, string>;
}
```

## Node Output Structure

```typescript
interface NodeOutput {
  status: "success" | "error" | "branched";
  output?: string; // Output passed to next node
  error?: string;
  branchTaken?: "true" | "false"; // For If/Else nodes
  metadata?: Record<string, unknown>;
}
```

## Available Node Types

| Node Type       | File               | Description               |
| --------------- | ------------------ | ------------------------- |
| `agent-prompt`  | `agent-prompt.ts`  | Call AI agent with prompt |
| `send-message`  | `send-message.ts`  | Send message to channel   |
| `if-else`       | `if-else.ts`       | Conditional branching     |
| `execute-tool`  | `execute-tool.ts`  | Execute a catalog tool    |
| `remote-invoke` | `remote-invoke.ts` | Invoke command on node    |
| `tts`           | `tts.ts`           | Text-to-speech conversion |
| `delay`         | `delay.ts`         | Wait for duration         |
| `custom-js`     | `custom-js.ts`     | Execute JavaScript        |

## Execution Flow

```
Trigger → [Node 1] → [Node 2] → [If/Else] → [Node 3a/3b] → [Node 4]
    ↓          ↓          ↓           ↓             ↓           ↓
  cron     agent      send      condition    true/false    finish
        prompt      message
```

## Adding a New Node Type

1. Create new file: `src/gateway/workflow-nodes/<node-type>.ts`
2. Implement `WorkflowNodeHandler` interface
3. Export handler
4. Register in `registry.ts`
5. Add UI config panel in `ui-next/app/workflows/node-config.tsx`
6. Add to sidebar palette in `ui-next/app/workflows/sidebar.tsx`

## Example: If/Else Node

```typescript
// src/gateway/workflow-nodes/if-else.ts

import type { WorkflowNodeHandler, NodeInput, NodeOutput } from "./types.js";

export const ifElseHandler: WorkflowNodeHandler = {
  actionType: "if-else",

  async execute(input: NodeInput, context: ExecutionContext): Promise<NodeOutput> {
    const { config, previousOutput } = input;
    const condition = config.condition as string;

    // Evaluate condition
    const result = evaluateCondition(condition, previousOutput, context.variables);

    return {
      status: "branched",
      branchTaken: result ? "true" : "false",
      output: previousOutput, // Pass through
    };
  },
};
```

## Configuration Schema

Each node type should define its configuration schema in the UI:

```typescript
// In node-config.tsx
{
  label: "If / Else",
  fields: [
    {
      name: "condition",
      type: "textarea",
      label: "Condition Expression",
      placeholder: "input.length > 100",
      help: "Available: input, variables, helpers (includes, startsWith, etc.)"
    }
  ]
}
```
