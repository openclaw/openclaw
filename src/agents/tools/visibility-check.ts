import { loadConfig } from "../../config/config.js";
import path from "node:path";

export type VisibilityCheckResult = {
  allowed: boolean;
  reason?: string;
};

/**
 * Simple glob matcher for visibility scope patterns.
 * Supports * (any chars) and ** (any path segments).
 */
function simpleGlobMatch(pattern: string, text: string): boolean {
  // Escape special regex chars except * and /
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  
  // Replace ** with a placeholder
  const withDoubleStar = escaped.replace(/\*\*/g, "%%DOUBLESTAR%%");
  
  // Replace * with [^/]* (match any char except /)
  const withSingleStar = withDoubleStar.replace(/\*/g, "[^/]*");
  
  // Replace ** placeholder with .* (match anything including /)
  const final = withSingleStar.replace(/%%DOUBLESTAR%%/g, ".*");
  
  const regex = new RegExp(`^${final}$`);
  return regex.test(text);
}

export function checkCrossWorkspaceVisibility(
  readerAgentId: string,
  writerAgentId: string,
  relativePath: string,
): VisibilityCheckResult {
  const cfg = loadConfig();
  const agents = cfg.agents?.list ?? [];
  
  const reader = agents.find(a => a.id === readerAgentId);
  const writer = agents.find(a => a.id === writerAgentId);
  
  if (!reader || !writer) {
    return { allowed: false, reason: "Agent not found" };
  }
  
  // Check mutual consent
  const readerCanRead = reader.visibility?.readFrom?.includes(writerAgentId) ?? false;
  const writerAllows = writer.visibility?.readableTo?.includes(readerAgentId) ?? false;
  
  if (!readerCanRead) {
    return { allowed: false, reason: `${readerAgentId} does not have ${writerAgentId} in readFrom` };
  }
  if (!writerAllows) {
    return { allowed: false, reason: `${writerAgentId} does not have ${readerAgentId} in readableTo` };
  }
  
  // Check scope on both sides
  const readerScope = reader.visibility?.scope ?? [];
  const writerScope = writer.visibility?.scope ?? [];
  
  const matchesReaderScope = readerScope.length === 0 || readerScope.some(pattern => {
    if (pattern.startsWith("!")) return false;
    return simpleGlobMatch(pattern, relativePath);
  });
  
  const matchesWriterScope = writerScope.length === 0 || writerScope.some(pattern => {
    if (pattern.startsWith("!")) return false;
    return simpleGlobMatch(pattern, relativePath);
  });
  
  // Check exclusions
  const excludedByReader = readerScope.some(pattern => 
    pattern.startsWith("!") && simpleGlobMatch(pattern.slice(1), relativePath)
  );
  const excludedByWriter = writerScope.some(pattern => 
    pattern.startsWith("!") && simpleGlobMatch(pattern.slice(1), relativePath)
  );
  
  if (!matchesReaderScope || excludedByReader) {
    return { allowed: false, reason: `Path not in reader's scope` };
  }
  if (!matchesWriterScope || excludedByWriter) {
    return { allowed: false, reason: `Path not in writer's scope` };
  }
  
  return { allowed: true };
}

export function resolveWorkspaceForAgent(agentId: string): string | undefined {
  const cfg = loadConfig();
  const agent = cfg.agents?.list?.find(a => a.id === agentId);
  return agent?.workspace;
}
