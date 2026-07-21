/**
 * Mythos Causal Graph — TypeScript Integration
 *
 * New capability — provides L7 causal memory for OpenClaw.
 * Integrates with extensions/memory-core/ as a new memory layer.
 *
 * Usage:
 *   import { createCausalGraph } from "../../mythos-native/causal-graph.js";
 *
 *   const graph = createCausalGraph();
 *   if (graph) {
 *     graph.addNode({ id: 'rain', nodeType: 'fact', ... });
 *     graph.addEdge('rain', 'wet', 'caused_by', 0.9);
 *     const chains = graph.findCausalChains('wet', 3);
 *   }
 */

import type {
  NativeCausalGraph,
  NativeCausalGraphInstance,
  NativeGraphNode,
  NativeCausalPath,
} from "./index.js";

let graphModule: NativeCausalGraph | null = null;
let loadAttempted = false;

async function ensureGraphModule(): Promise<NativeCausalGraph | null> {
  if (loadAttempted) return graphModule;
  loadAttempted = true;

  try {
    graphModule = (await import(
      "@openclaw/mythos-causal-graph"
    )) as unknown as NativeCausalGraph;
  } catch {
    graphModule = null;
  }

  return graphModule;
}

/**
 * Create a new causal graph instance.
 * Returns null if the native module is not available.
 */
export async function createCausalGraph(): Promise<NativeCausalGraphInstance | null> {
  const mod = await ensureGraphModule();
  if (!mod) return null;

  try {
    return new mod();
  } catch {
    return null;
  }
}

/**
 * Load an existing causal graph from disk.
 */
export async function loadCausalGraph(
  path: string,
): Promise<NativeCausalGraphInstance | null> {
  const mod = await ensureGraphModule();
  if (!mod) return null;

  try {
    return mod.load(path);
  } catch {
    return null;
  }
}

/**
 * Check if the causal graph module is available.
 */
export async function isCausalGraphAvailable(): Promise<boolean> {
  const mod = await ensureGraphModule();
  return mod !== null;
}
