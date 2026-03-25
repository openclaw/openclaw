# Mega-Writer Skill

Generate large documents (10K-100K+ words) with parallel agents and real-time progress tracking.

## When to Use

- Large document generation (reports, audits, encyclopedias)
- Multi-chapter content requiring parallel writing
- Projects needing real-time visibility

## Architecture

```
┌─────────────┐     ┌─────────────┐
│   Main      │────▶│  Dashboard  │ (localhost:8889)
│   Agent     │     │  progress   │
└──────┬──────┘     └─────────────┘
       │
       ▼ sessions_spawn()
┌──────┴──────┬──────────┬──────────┐
▼             ▼          ▼          ▼
Writer-1    Writer-2   Writer-3   Writer-4
Ch 1-3      Ch 4-5     Ch 6-7     Ch 8-10
```

## Quick Start

### 1. Setup Project

```bash
mkdir -p mega-writer/{data,output/sections}
```

### 2. Create Outline (outline.json)

```json
{
  "title": "Document Title",
  "chapters": [
    {
      "id": 1,
      "title": "Chapter 1",
      "sections": [{ "id": "1.1", "title": "Section Title", "target_words": 500 }]
    }
  ]
}
```

### 3. Create Progress Tracker (progress.json)

```json
{
  "sections_completed": [],
  "total_words_written": 0,
  "last_updated": ""
}
```

### 4. Spawn Parallel Writers

```javascript
// From main agent:
sessions_spawn({
  task: "Write chapters 1-3 of [document]. Save each section to mega-writer/output/sections/section-X-X.md. Update progress.json after each section.",
  label: "writer-1",
});
// Repeat for writer-2, writer-3, writer-4
```

### 5. Dashboard (dashboard.html)

```html
<script>
  setInterval(async () => {
    const p = await fetch("/progress.json").then((r) => r.json());
    document.getElementById("progress").textContent =
      `${p.sections_completed.length}/49 sections | ${p.total_words_written} words`;
  }, 3000);
</script>
```

### 6. Serve Dashboard

```bash
cd mega-writer && python3 -m http.server 8889
```

## Output Formats

### MD → PDF Conversion

```bash
# Step 1: MD → HTML
pandoc input.md -o output.html --standalone --toc --toc-depth=2

# Step 2: HTML → PDF (Chrome headless)
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --headless --disable-gpu \
  --print-to-pdf=output.pdf \
  file://$(pwd)/output.html
```

### Upload to Google Drive

```bash
rclone copy output.pdf "gdrive:Folder/"
rclone link "gdrive:Folder/output.pdf"  # Get shareable link
```

## Best Practices

1. **Parallel Agents**: 4 agents = 4x speed
2. **Progress Tracking**: Update progress.json after each section
3. **Real-time Dashboard**: Auto-refresh every 3 seconds
4. **PDF Output**: Always deliver PDF for stakeholders
5. **Google Drive**: Use rclone for instant sharing

## Files Reference

- `/mega-writer/outline.json` - Document structure
- `/mega-writer/progress.json` - Progress tracker
- `/mega-writer/output/sections/` - Individual sections
- `/mega-writer/output/FINAL.md` - Merged document
- `/mega-writer/output/FINAL.pdf` - PDF version
