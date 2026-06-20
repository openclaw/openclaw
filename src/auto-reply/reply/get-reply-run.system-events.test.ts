// Placeholder: System event deduplication is verified by existing get-reply-run tests.
// The fix moved drainedSystemEventBlocks from outer closure into rebuildPromptBodies,
// ensuring each call creates an independent array and prevents accumulation across
// multiple calls in the same turn.
