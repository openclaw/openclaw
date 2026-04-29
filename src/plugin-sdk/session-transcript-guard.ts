/**
 * Narrow re-export of `guardSessionManager` for use by bundled extensions
 * (e.g. Codex) that need to wrap SessionManager writes with redaction and
 * before_message_write hook support.
 *
 * This is intentionally NOT part of the `agent-harness-runtime` barrel so that
 * it does not appear in the public Plugin SDK API surface consumed by
 * third-party plugins.  Third-party plugins should not depend on internal
 * session-write plumbing.
 */
export { guardSessionManager } from "../agents/session-tool-result-guard-wrapper.js";
