# Tracking Templates

Ready-to-use templates for affiliate link tracking across platforms.

## Google Sheets Tracking Template

Create a spreadsheet with these columns:

| Column       | Description                    | Example                                      |
| ------------ | ------------------------------ | -------------------------------------------- |
| Link Name    | Naming convention ID           | `heygen-linkedin-review-v1`                  |
| Platform     | Traffic source                 | `linkedin`                                   |
| Content Type | What kind of content           | `social_post`                                |
| Tagged URL   | Full UTM-tagged URL            | `heygen.com/ref/abc?utm_source=linkedin&...` |
| Date Created | When the link was created      | `2026-03-15`                                 |
| Clicks       | Running total                  | `142`                                        |
| Conversions  | Running total                  | `5`                                          |
| Revenue      | Running total ($)              | `72.00`                                      |
| EPC          | Auto-calculate: Revenue/Clicks | `$0.51`                                      |
| Notes        | Context                        | `Used in transformation story post`          |

## UTM Parameter Reference

| Parameter      | Purpose                  | Values                                                                 |
| -------------- | ------------------------ | ---------------------------------------------------------------------- |
| `utm_source`   | Where traffic comes from | `linkedin`, `twitter`, `reddit`, `blog`, `email`, `tiktok`, `youtube`  |
| `utm_medium`   | How traffic arrives      | `social`, `article`, `email`, `paid`, `bio_link`                       |
| `utm_campaign` | Campaign identifier      | `{product}-{quarter}-{year}` e.g., `heygen-q1-2026`                    |
| `utm_content`  | Specific content piece   | `review-post`, `comparison-table`, `cta-button`, `bio-link`, `email-3` |

## Platform-Specific Tracking Notes

### LinkedIn

- Link in first comment (not post body) — track separately from blog links
- `utm_content` should specify: `post-comment`, `article-inline`, `profile-bio`

### X/Twitter

- Link in last tweet of thread
- `utm_content`: `thread-cta`, `tweet-bio`, `pinned-tweet`

### Reddit

- Link in comment reply, NOT post body (anti-spam)
- `utm_content`: `comment-reply`, `profile-bio`
- Some subreddits strip UTM params — use a redirect shortener as backup

### Blog

- Multiple link placements per article: track each separately
- `utm_content`: `intro-cta`, `comparison-table`, `verdict-cta`, `sidebar-widget`

### Email

- Tag each email in the sequence separately
- `utm_content`: `welcome-email`, `email-3-case-study`, `email-5-cta`

## Connecting to Performance Report (S6)

The tracking data you collect feeds directly into the `performance-report` skill:

- Export your spreadsheet as: program name, clicks, conversions, revenue
- Run performance-report with that data to get EPC analysis, program labels, and recommendations
- This closes the loop: S1 (pick program) → S2-S5 (create content) → S6 (track) → S6 (analyze) → back to S1 (optimize)
