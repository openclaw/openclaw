#!/usr/bin/env python3
"""
Parallel URL Fetcher for EVOX
Usage: python parallel-fetch.py url1 url2 url3 ... -o output.md
"""

import asyncio
import aiohttp
import argparse
import sys
from datetime import datetime

async def fetch_url(session, url, timeout=30):
    """Fetch a single URL with timeout"""
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=timeout)) as response:
            if response.status == 200:
                text = await response.text()
                # Basic text extraction (remove HTML tags)
                import re
                text = re.sub(r'<script[^>]*>.*?</script>', '', text, flags=re.DOTALL)
                text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL)
                text = re.sub(r'<[^>]+>', ' ', text)
                text = re.sub(r'\s+', ' ', text).strip()
                return {
                    'url': url,
                    'status': 'success',
                    'content': text[:10000]  # Limit content
                }
            else:
                return {
                    'url': url,
                    'status': 'error',
                    'error': f'HTTP {response.status}'
                }
    except Exception as e:
        return {
            'url': url,
            'status': 'error',
            'error': str(e)
        }

async def fetch_all(urls):
    """Fetch all URLs in parallel"""
    async with aiohttp.ClientSession() as session:
        tasks = [fetch_url(session, url) for url in urls]
        return await asyncio.gather(*tasks)

def main():
    parser = argparse.ArgumentParser(description='Parallel URL Fetcher')
    parser.add_argument('urls', nargs='+', help='URLs to fetch')
    parser.add_argument('-o', '--output', help='Output file (markdown)')
    parser.add_argument('-q', '--quiet', action='store_true', help='Quiet mode')
    args = parser.parse_args()

    if not args.quiet:
        print(f"🔄 Fetching {len(args.urls)} URLs in parallel...")

    results = asyncio.run(fetch_all(args.urls))

    output_lines = [
        f"# Parallel Fetch Results",
        f"Generated: {datetime.now().isoformat()}",
        f"URLs fetched: {len(args.urls)}",
        "",
        "---",
        ""
    ]

    success_count = 0
    for result in results:
        if result['status'] == 'success':
            success_count += 1
            output_lines.append(f"## ✅ {result['url']}")
            output_lines.append("")
            output_lines.append(result['content'][:2000] + "..." if len(result['content']) > 2000 else result['content'])
            output_lines.append("")
            output_lines.append("---")
            output_lines.append("")
        else:
            output_lines.append(f"## ❌ {result['url']}")
            output_lines.append(f"Error: {result['error']}")
            output_lines.append("")

    output_text = "\n".join(output_lines)

    if args.output:
        with open(args.output, 'w') as f:
            f.write(output_text)
        if not args.quiet:
            print(f"✅ Saved to {args.output}")
    else:
        print(output_text)

    if not args.quiet:
        print(f"\n📊 Success: {success_count}/{len(args.urls)}")

if __name__ == '__main__':
    main()
