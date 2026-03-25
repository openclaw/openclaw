# Domain & Hosting Setup Guide

## Quick Deploy Options

### Option 1: Netlify Drop (Easiest — 30 seconds)

1. Go to https://app.netlify.com/drop
2. Drag your `.html` file onto the page
3. Done — you get a URL like `random-name-123.netlify.app`
4. Optional: sign up to claim a custom subdomain (`yourname.netlify.app`)

**Custom domain on Netlify:**

1. Sign up at netlify.com (free tier is fine)
2. Go to Site Settings → Domain Management → Add custom domain
3. Enter your domain (e.g., `links.yourdomain.com`)
4. Add the DNS records Netlify provides:
   - CNAME: `links` → `your-site.netlify.app`
   - Or: A record → Netlify's load balancer IP
5. Enable HTTPS (automatic via Let's Encrypt)

### Option 2: Vercel (Developer-friendly)

1. Install Vercel CLI: `npm i -g vercel`
2. Create a directory with your `.html` file
3. Run: `npx vercel deploy --prod`
4. Follow the prompts — you get a URL like `your-project.vercel.app`

**Custom domain on Vercel:**

1. Go to your project dashboard → Settings → Domains
2. Add your domain
3. Add DNS records as instructed (CNAME or nameserver delegation)
4. HTTPS is automatic

### Option 3: GitHub Pages (Free, version-controlled)

1. Create a new GitHub repository (can be private with Pages on free tier)
2. Add your `.html` file as `index.html`
3. Go to Settings → Pages → Source: "Deploy from a branch" → `main` → `/ (root)`
4. Your site is live at `username.github.io/repo-name`

**Custom domain on GitHub Pages:**

1. In repo Settings → Pages → Custom domain, enter your domain
2. Add DNS records:
   - CNAME: `links` → `username.github.io`
   - Or A records: GitHub's IPs (185.199.108-111.153)
3. Check "Enforce HTTPS"
4. Add a `CNAME` file to the repo root with your domain name

### Option 4: Local Only (Preview)

Just double-click the `.html` file — it opens in your default browser. No server needed since it's a self-contained file.

## Domain Recommendations

For a bio link page, use a short, memorable subdomain:

- `links.yourdomain.com` — professional, branded
- `go.yourdomain.com` — short and clean
- `bio.yourdomain.com` — obvious purpose

If you don't have a domain, free options:

- `yourname.netlify.app` (Netlify)
- `yourname.vercel.app` (Vercel)
- `username.github.io/links` (GitHub Pages)

## DNS Basics

If you're new to DNS, here's what you need to know:

- **A record**: Points a domain to an IP address. Use for root domains (`yourdomain.com`).
- **CNAME record**: Points a subdomain to another domain. Use for subdomains (`links.yourdomain.com`).
- **TTL**: How long DNS records are cached. Set to 300 (5 minutes) while testing, 3600 (1 hour) when stable.
- **Propagation**: DNS changes take 1-48 hours to spread globally. Usually under 30 minutes.

Common domain registrars: Namecheap, Cloudflare, Google Domains, Porkbun.

## SSL/HTTPS

All three hosting options (Netlify, Vercel, GitHub Pages) provide free automatic HTTPS via Let's Encrypt. No configuration needed — just add your domain and wait a few minutes.

**Important**: Always use `https://` links in your bio page. Mixed content (HTTP on an HTTPS page) will cause browser warnings.
