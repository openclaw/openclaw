# WordPress Deployment Guide

> Reference for users who want to publish their blog article to WordPress.

## Quick Paste Method

1. Copy the full markdown article output
2. In WordPress, create a new post
3. Switch to the **Code Editor** (top-right "..." menu → Code Editor)
4. Paste the markdown — WordPress will render it as HTML blocks
5. Switch back to Visual Editor to review formatting

**Tip**: If your WordPress doesn't render markdown natively, use a plugin like **WP Githuber MD** or convert to HTML first using an online converter.

## Formatting Checklist

After pasting, verify these elements in the Visual Editor:

- [ ] H1 title matches the post title field
- [ ] All H2/H3 headings render correctly (not as plain text)
- [ ] Comparison tables display properly (may need a table plugin)
- [ ] Bullet points and numbered lists are formatted
- [ ] Affiliate links are clickable and correct
- [ ] FTC disclosure is visible near the top
- [ ] No broken markdown syntax showing as raw text

## Yoast SEO Setup

If you have **Yoast SEO** (or similar plugin) installed:

### SEO Title

- Copy the article title from the output
- Yoast format: `[Article Title] | [Your Site Name]`
- Keep under 60 characters total

### Meta Description

- Copy the `meta_description` from the SEO metadata block
- Should be 150-160 characters
- Yoast will show green if it's the right length

### Focus Keyphrase

- Enter the `target_keyword` from the SEO metadata block
- Yoast will analyze keyword usage and show a score
- Aim for green on: keyphrase in title, meta, first paragraph, headings, URL

### Slug / URL

- Use the `slug` from the SEO metadata block
- Format: `your-site.com/[slug]`
- Keep it short, keyword-rich, no stop words

### Readability

- Yoast's readability analysis should score green/orange
- Short paragraphs, transition words, and subheadings help

## Affiliate Link Setup

### Using Pretty Links (Recommended)

1. Install **Pretty Links** plugin
2. Create a pretty link for each affiliate URL:
   - Target URL: `https://partner.product.com/your-affiliate-id`
   - Pretty Link: `your-site.com/go/product-name`
3. Replace raw affiliate URLs in the article with pretty links
4. Benefits: cleaner URLs, click tracking, easy link updates

### Link Attributes

Add these attributes to all affiliate links:

- `rel="nofollow sponsored"` — tells Google it's a paid link
- `target="_blank"` — opens in new tab
- In WordPress block editor: click the link → Advanced → add `nofollow sponsored` to rel field

### Disclosure Placement

- The article already includes an FTC disclosure near the top
- Some bloggers also add a shorter disclosure in the sidebar widget
- WordPress: add a **Custom HTML** block if the disclosure didn't paste correctly

## Images

The article output includes image suggestions. To add them:

1. **Product screenshots**: Visit the product site, take screenshots of the dashboard/features
2. **Comparison tables**: If the markdown table doesn't render well, screenshot it as an image
3. **Feature highlights**: Annotate screenshots with arrows/circles using a tool like Skitch or Markup Hero

### Image Optimization

- Compress images before uploading (use TinyPNG or ShortPixel plugin)
- Set alt text using the suggestions from the article output
- Use descriptive file names: `heygen-pricing-plans-2025.png`

## FAQ Schema (Structured Data)

The article includes FAQ questions formatted for schema markup. To add FAQ schema:

### Option A: Yoast SEO (Easiest)

1. In the block editor, add a **Yoast FAQ Block**
2. Copy each Q&A from the FAQ section into the Yoast block
3. Yoast automatically generates the JSON-LD schema

### Option B: Manual JSON-LD

Add this to the post's custom HTML or header:

```html
<script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": [
      {
        "@type": "Question",
        "name": "Your question here?",
        "acceptedAnswer": {
          "@type": "Answer",
          "text": "Your answer here."
        }
      }
    ]
  }
</script>
```

### Option C: Rank Math

If using Rank Math instead of Yoast: use the FAQ block in Rank Math's block library (same concept).

## Publishing Checklist

Before hitting "Publish":

- [ ] SEO title and meta description are set
- [ ] Focus keyword is entered in Yoast/Rank Math
- [ ] URL slug is clean and keyword-rich
- [ ] Featured image is set (product logo or hero image)
- [ ] Categories and tags are assigned
- [ ] FTC disclosure is visible above the fold
- [ ] All affiliate links work and have `rel="nofollow sponsored"`
- [ ] FAQ schema is implemented (Yoast FAQ block or JSON-LD)
- [ ] Article reads well on mobile (preview on phone)
- [ ] Internal links to related posts are added (if any)
- [ ] "Last updated" date is accurate

## Alternative Platforms

The article output is portable markdown. It also works with:

- **Ghost**: Paste markdown directly in the editor (native support)
- **Hugo / Astro / Gatsby**: Save as `.md` file in your content directory
- **Substack**: Paste in the editor (limited markdown support — tables may need manual formatting)
- **Medium**: Use a markdown-to-Medium converter or paste and reformat
- **Webflow**: Use the Rich Text element and paste formatted content

For non-WordPress platforms, the SEO metadata block provides all the info you need to configure SEO settings in that platform's interface.
