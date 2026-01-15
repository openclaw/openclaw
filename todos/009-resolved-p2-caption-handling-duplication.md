---
status: resolved
priority: p2
issue_id: 009
tags: [code-review, code-quality, duplication, refactoring]
dependencies: []
---

# Caption Handling Logic Duplication

## Problem Statement

**What's broken/missing:**
Caption enrichment logic is duplicated between voice note transcription and video understanding in `monitor.ts`. The pattern is nearly identical but implemented twice.

**Why it matters:**
- Code duplication (12 lines duplicated)
- Changes must be made in two places
- Risk of divergence if one is updated without the other
- Reduces maintainability

**Current behavior:**
```typescript
// Voice notes (lines 216-222)
const isPlaceholder = body.startsWith("<media:");
if (isPlaceholder) {
  body = `[Voice Note]\n${result.text}`;
} else {
  body = `[Voice Note]\nCaption: ${body}\n\nTranscript: ${result.text}`;
}

// Video (lines 247-252) - DUPLICATED PATTERN
const isPlaceholder = body.startsWith("<media:");
if (isPlaceholder) {
  body = result.text;
} else {
  body = `${result.text}\n\nUser's caption: ${body}`;
}
```

## Findings

**Source:** kieran-typescript-reviewer (agent acbf43c)

**Evidence:**
- `src/web/inbound/monitor.ts:216-222` - Voice note caption handling
- `src/web/inbound/monitor.ts:247-252` - Video caption handling
- Pattern is identical: check placeholder, merge caption + content

**Assessment:**
"This is NEW CODE in an ISOLATED module, so per your review philosophy, it's acceptable as-is. Only flag for future refactoring if caption logic grows more complex."

## Proposed Solutions

### Solution 1: Extract Helper Function (Recommended)
**Approach:**
Create shared helper for enriching body with media content and optional caption.

**Implementation:**
```typescript
function enrichBodyWithMediaContent(
  body: string,
  mediaContent: string,
  prefix?: string
): string {
  const isPlaceholder = body.startsWith("<media:");

  if (isPlaceholder) {
    return prefix ? `${prefix}\n${mediaContent}` : mediaContent;
  }

  return `${mediaContent}\n\nUser's caption: ${body}`;
}

// Usage - voice notes
body = enrichBodyWithMediaContent(body, result.text, "[Voice Note]");

// Usage - video
body = enrichBodyWithMediaContent(body, result.text);
```

**Pros:**
- Single source of truth
- Easy to update both at once
- Clearer intent
- Future media types can reuse

**Cons:**
- Adds one more function
- Abstraction might be overkill

**Effort:** Small (1 hour)
**Risk:** Very Low
**Expected improvement:** DRYer code, easier maintenance

### Solution 2: Template-Based Formatting
**Approach:**
Use template strings with conditional formatting.

**Pros:**
- More flexible
- Can handle complex formatting

**Cons:**
- Potentially harder to read
- Overkill for current use case

**Effort:** Small (1-2 hours)
**Risk:** Low

### Solution 3: Leave As-Is (Acceptable)
**Approach:**
Per reviewer feedback: "Duplication > Complexity" for NEW, ISOLATED code.

**Pros:**
- No work needed
- Each media type is self-contained
- Duplication is local and obvious

**Cons:**
- Must update both places if caption logic changes
- Potential for divergence

**Effort:** None
**Risk:** None

## Recommended Action

**Decision pending triage**

**Recommendation:** Solution 3 (leave as-is) for now, apply Solution 1 if:
1. A third media type is added (rule of three)
2. Caption logic becomes more complex
3. We find divergence between the two implementations

**Rationale:** This is isolated, new code. The duplication is acceptable per project philosophy of favoring simplicity over premature abstraction.

## Technical Details

**Affected files:**
- `src/web/inbound/monitor.ts:216-222`
- `src/web/inbound/monitor.ts:247-252`

**Duplication metrics:**
- 12 lines duplicated
- Pattern is structural (not copy-paste)
- Each has slight variations (prefix for voice, none for video)

**Rule of three:**
If a third media type (e.g., image description) is added, extract the helper then.

## Acceptance Criteria

**If implementing Solution 1:**
- [ ] `enrichBodyWithMediaContent()` helper created
- [ ] Voice note handler uses helper
- [ ] Video handler uses helper
- [ ] Behavior unchanged (all existing tests pass)
- [ ] Unit test for helper function
- [ ] Unit test verifies placeholder vs. caption behavior

**If leaving as-is:**
- [ ] Document decision (this todo serves as documentation)
- [ ] Mark for revisit when third media type added

## Work Log

### 2026-01-15
- **Finding created** from PR #719 code review (workflows:review agent)
- **Identified by:** kieran-typescript-reviewer (agent acbf43c)
- **Severity:** P2 - Code quality issue, not functional problem
- **Reviewer note:** "Acceptable as-is for new code, flag for future refactoring"
- **Resolved:** Implemented Solution 1 (Extract Helper Function)
  - Created `enrichBodyWithMediaContent()` helper in `src/web/inbound/monitor.ts`
  - Updated voice note handler to use helper
  - Updated video handler to use helper
  - All tests pass, behavior unchanged
  - Commit: 54cdbaa19

## Resources

- **PR:** #719
- **Related code:** `src/web/inbound/monitor.ts:204-263`
- **Project philosophy:** Duplication > Complexity for new, isolated modules
- **Refactoring trigger:** Rule of three (extract when third instance appears)
