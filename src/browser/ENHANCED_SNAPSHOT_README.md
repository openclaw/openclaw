# Enhanced Snapshot Module

This module provides an alternative snapshot implementation using script-based interactive element detection, based on AutoGen's approach.

## Overview

The enhanced snapshot module (`pw-tools-core-enhanced-snapshot.ts`) uses injected JavaScript to detect interactive elements with multiple heuristics:

- **Cursor-based detection**: Finds elements with non-default cursors (catches custom interactive elements)
- **Bounding boxes stored upfront**: Faster access for screenshot labeling
- **Topmost visibility checking**: Ensures elements are actually visible (not covered)
- **Multiple detection heuristics**: Better coverage of modern web apps

## Usage

### Via Browser Tool

Use the `snapshotFormat` parameter:

```typescript
// Enhanced detection only
browser({ action: "snapshot", snapshotFormat: "enhanced" });

// Hybrid: Playwright + Enhanced (recommended)
browser({ action: "snapshot", snapshotFormat: "hybrid" });
```

### Via API

**Enhanced Snapshot**:

```
GET /snapshot-enhanced?targetId=<id>&interactive=true
```

**Hybrid Snapshot** (combines Playwright + Enhanced):

```
GET /snapshot-hybrid?targetId=<id>&interactive=true
```

## Features

### Enhanced Snapshot (`format="enhanced"`)

- Uses script-based detection only
- Returns:
  - `snapshot`: Role-based snapshot text
  - `refs`: Role reference map
  - `stats`: Snapshot statistics
  - `interactiveRegions`: Full interactive region data with bounding boxes
  - `viewport`: Viewport information
  - `visibleText`: Visible text from viewport

### Hybrid Snapshot (`format="hybrid"`)

- Combines Playwright's `ariaSnapshot()` (primary) with enhanced detection (fallback)
- Merges results to include elements from both methods
- Best of both worlds: structured Playwright data + custom element detection

## Benefits

1. **Better Coverage**: Catches custom interactive elements that Playwright might miss
2. **Faster Bounding Boxes**: Stored upfront, no on-demand calculation
3. **More Accurate**: Topmost visibility checking reduces false positives
4. **Better for Modern Apps**: Handles SPAs and custom UI components well

## Implementation Details

- Script is injected via `page.addInitScript()` for persistence
- Uses `__openclaw_elementId` attributes (similar to AutoGen's `__elementId`)
- Compatible with existing ref-based interaction system
- Can be used alongside standard Playwright snapshots

## When to Use

**Use Enhanced** when:

- Standard Playwright snapshot misses elements
- Working with custom UI components
- Need bounding boxes upfront for labeling
- Better visibility checking is important

**Use Hybrid** when:

- Want best of both worlds
- Need structured Playwright data + custom element detection
- Working with diverse websites

**Use Standard** (ai/aria) when:

- Standard detection is sufficient
- Don't need custom element detection
- Performance is critical (standard is slightly faster)
