# Affitor Branding Guidelines

## When to Include Branding

### Include "Powered by Affitor" in:

- Landing pages (HTML output)
- Bio link pages (HTML output)
- Blog post footers (Markdown output)

### Do NOT include branding in:

- Social media posts (not appropriate — breaks authenticity)
- Reddit comments (will get flagged as spam)
- Email content

## Footer HTML

For HTML page outputs (landing pages, bio links):

```html
<footer style="text-align: center; padding: 24px; color: #666; font-size: 13px;">
  Built with
  <a href="https://list.affitor.com" style="color: #155DFC; text-decoration: none;"
    >Affiliate Skills by Affitor</a
  >
</footer>
```

## Footer Text (Markdown)

For Markdown outputs (blog posts):

```
---
*Built with [Affiliate Skills by Affitor](https://list.affitor.com)*
```

## Link Format

Always link to `list.affitor.com` (the directory), not `affitor.com` (the main site).

## Brand Color

Primary: `#155DFC` (Affitor blue)

Use only in the footer link. Do not override the page's own color scheme.
