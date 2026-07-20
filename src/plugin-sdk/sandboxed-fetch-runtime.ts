// Narrow runtime subpath for plugins that fetch and parse untrusted external
// content. Routes the actual network fetch + HTML extraction through the
// calling agent's Docker sandbox container when one exists, falling back to
// in-process fetch+extract otherwise -- see src/agents/sandbox/sandboxed-fetch.ts
// for the real implementation.

export {
  fetchAndExtractSandboxed,
  type FetchAndExtractSandboxedResult,
} from "../agents/sandbox/sandboxed-fetch.js";
