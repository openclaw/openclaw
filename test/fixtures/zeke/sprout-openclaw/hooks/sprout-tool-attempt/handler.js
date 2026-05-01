'use strict';

const DEFAULT_EVENTS_URL = 'http://host.docker.internal:3747/events/sprout-hook';
const SOURCE = 'sprout-openclaw';
const DENIED_TOOLS = new Set([
  'browser',
  'web_fetch',
  'x_search',
  'tavily_search',
  'tavily_extract',
  'group:web',
  'canvas',
  'write',
  'edit',
  'apply_patch',
  'exec',
  'process',
  'package-install',
  'docker',
]);
const WEB_BUILTINS = new Set(['web_search', ...DENIED_TOOLS]);
const DEADLINE_MS = 750;

async function handler(event = {}) {
  const toolName = toolNameFromEvent(event);
  if (!toolName) return { allow: true };
  const normalized = normalizeToolName(toolName);
  const base = {
    agent_id: 'sprout',
    hook_name: 'pre-tool',
    tool_name: toolName,
    normalized_tool_name: normalized,
    tool_source: toolSource(toolName),
    caller: { agent_id: 'sprout', surface: 'openclaw', session_id: sessionIdFromEvent(event) },
    argument_shape: shapeSummary(argsFromEvent(event)),
    openclaw_turn_id: turnIdFromEvent(event),
  };

  if (DENIED_TOOLS.has(normalized)) {
    try {
      await emitEvent('tool:sprout.call_attempted', 'info', base, event);
      await emitEvent('tool:sprout.call_denied', 'warning', {
        ...base,
        denial_reason: 'blocked_by_sprout_tool_profile',
        policy_source: 'entities/sprout/openclaw/config/openclaw.json',
      }, event);
    } catch (err) {
      await emitHookError(event, err, 'pre_tool', toolName);
    }
    return { allow: false, reason: 'blocked_by_sprout_tool_profile' };
  }

  const queryViolation = normalized === 'web_search'
    ? webSearchQueryDisciplineViolation(argsFromEvent(event))
    : null;
  const attemptedPayload = {
    ...base,
    query_discipline: queryViolation ? { blocked: true, reason: queryViolation } : { blocked: false },
  };

  if (queryViolation) {
    try {
      await emitEvent('tool:sprout.call_attempted', 'info', attemptedPayload, event);
      await emitEvent('tool:sprout.call_denied', 'warning', {
        ...base,
        denial_reason: 'blocked_by_web_search_query_discipline',
        policy_source: 'entities/sprout/openclaw/workspace/skills/web-search-discipline/SKILL.md',
        query_discipline: { blocked: true, reason: queryViolation },
      }, event);
    } catch (err) {
      await emitHookError(event, err, 'pre_tool', toolName);
    }
    return { allow: false, reason: 'blocked_by_web_search_query_discipline' };
  }

  try {
    await emitEvent('tool:sprout.call_attempted', 'info', {
      ...attemptedPayload,
    }, event);
  } catch (err) {
    await emitHookError(event, err, 'pre_tool', toolName);
  }
  return { allow: true };
}

async function emitEvent(eventType, severity, payload, event) {
  const fetchImpl = event.fetch || globalThis.fetch;
  const token = event.env?.SPROUT_OPENCLAW_HOOK_TOKEN || process.env.SPROUT_OPENCLAW_HOOK_TOKEN || '';
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
  if (!token) throw new Error('SPROUT_OPENCLAW_HOOK_TOKEN missing');
  const res = await withDeadline(fetchImpl(event.eventsUrl || DEFAULT_EVENTS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: SOURCE, category: eventType.split(':')[0], event_type: eventType, severity, payload }),
  }), DEADLINE_MS);
  if (!res || res.status < 200 || res.status >= 300) throw new Error(`event append failed with status ${res && res.status}`);
}

async function emitHookError(event, err, phase, toolName) {
  try {
    await emitEvent('ops:sprout.hook_error', 'warning', {
      agent_id: 'sprout',
      hook_name: 'pre-tool',
      phase,
      classification: classifyError(err),
      message: String(err && err.message ? err.message : err).slice(0, 300),
      stack_summary: stackSummary(err),
      tool_name: toolName || null,
      openclaw_turn_id: turnIdFromEvent(event),
      session_id: sessionIdFromEvent(event),
    }, event);
  } catch (_) {}
}

function withDeadline(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('hook deadline exceeded')), ms)),
  ]);
}

function toolNameFromEvent(event) {
  return String(event.context?.tool_name || event.context?.toolName || event.tool_name || event.toolName || event.name || '').trim();
}

function argsFromEvent(event) {
  return event.context?.arguments || event.context?.args || event.arguments || event.args || {};
}

function sessionIdFromEvent(event) {
  return String(event.sessionKey || event.session_id || event.context?.session_id || 'hook:sprout');
}

function turnIdFromEvent(event) {
  return event.openclaw_turn_id || event.context?.openclaw_turn_id || null;
}

function normalizeToolName(name) {
  const text = String(name || '');
  return text.includes('__') ? text.split('__').pop() : text;
}

function toolSource(name) {
  if (String(name).includes('__')) return 'mcp';
  if (WEB_BUILTINS.has(normalizeToolName(name))) return 'openclaw_builtin';
  return 'unknown';
}

function webSearchQueryDisciplineViolation(args) {
  const query = extractQuery(args);
  if (!query) return null;
  if (hasSecretMaterial(query)) return 'possible_secret_material';
  if (hasLocalOrRepoPrivateMaterial(query)) return 'possible_local_or_repo_private_material';
  if (hasCustomerPrivateMaterial(query)) return 'possible_customer_private_material';
  if (hasUnreleasedZekeStrategy(query)) return 'possible_unreleased_zeke_strategy';
  return null;
}

function extractQuery(args) {
  if (!args || typeof args !== 'object') return '';
  const raw = args.query || args.q || args.search || args.prompt || '';
  return typeof raw === 'string' ? raw : '';
}

function hasSecretMaterial(query) {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(query)
    || /\b(?:sk|tvly|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_./-]{8,}/i.test(query)
    || /\b(?:bearer|token|secret|api[_-]?key|password|credential)\s*[:=]\s*\S+/i.test(query)
    || /\b(?:SPROUT|ZEKE|CLAUDE|ANTHROPIC|OPENAI|TAVILY)_[A-Z0-9_]*(?:TOKEN|KEY|SECRET)\b/.test(query);
}

function hasLocalOrRepoPrivateMaterial(query) {
  return /\bfile:\/\//i.test(query)
    || /(^|\s)(?:\/home\/|\/mnt\/|\/etc\/|[A-Za-z]:\\)/.test(query)
    || /(^|[\s"'`])(?:\.env|AGENTS\.md|CLAUDE\.md)(?:\b|$)/.test(query)
    || /\b(?:entities|zekeflow|scripts|artifacts|config|docs)\/[A-Za-z0-9._/-]+/.test(query)
    || /```[\s\S]{20,}```/.test(query);
}

function hasCustomerPrivateMaterial(query) {
  return /\b(?:customer|client|user)\s+(?:data|record|email|phone|token|secret|credential)\b/i.test(query)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(query);
}

function hasUnreleasedZekeStrategy(query) {
  return /\bunreleased\s+(?:zeke\s+)?(?:strategy|roadmap|plan|brief|launch)\b/i.test(query)
    || /\b(?:confidential|private)\s+(?:zeke\s+)?(?:strategy|roadmap|brief|customer|pricing)\b/i.test(query);
}

function shapeSummary(value) {
  const obj = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const keys = Object.keys(obj).slice(0, 200);
  const redacted = keys.filter((key) => /token|secret|key|password|auth|cookie/i.test(key));
  const types = {};
  for (const key of keys) types[key] = Array.isArray(obj[key]) ? 'array' : typeof obj[key];
  return {
    keys,
    types,
    redacted_keys: redacted,
    size_bytes: Buffer.byteLength(JSON.stringify(obj), 'utf8'),
    truncated: Object.keys(obj).length > keys.length,
  };
}

function classifyError(err) {
  const msg = String(err && err.message ? err.message : err).toLowerCase();
  if (msg.includes('token') || msg.includes('auth')) return 'auth';
  if (msg.includes('status 4')) return 'schema';
  if (msg.includes('deadline') || msg.includes('timeout')) return 'timeout';
  if (msg.includes('fetch') || msg.includes('network')) return 'network';
  return 'internal';
}

function stackSummary(err) {
  return String((err && err.stack) || '')
    .split('\n')
    .slice(0, 5)
    .filter(Boolean);
}

module.exports = handler;
module.exports.default = handler;
module.exports._test = { normalizeToolName, shapeSummary, toolSource, webSearchQueryDisciplineViolation };
