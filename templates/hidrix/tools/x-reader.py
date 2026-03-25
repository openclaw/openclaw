#!/usr/bin/env python3
"""
X/Twitter Reader - Extract tweet content using multiple methods
"""
import sys
import json
import subprocess
import re
from urllib.parse import urlparse

def extract_tweet_id(url):
    """Extract tweet ID from X/Twitter URL"""
    match = re.search(r'/status/(\d+)', url)
    return match.group(1) if match else None

def method_syndication(tweet_id):
    """Try Twitter syndication API (public, no auth)"""
    try:
        url = f"https://cdn.syndication.twimg.com/tweet-result?id={tweet_id}&token=0"
        result = subprocess.run(
            ['curl', '-s', '-L', url],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0 and result.stdout:
            data = json.loads(result.stdout)
            return {
                'method': 'syndication',
                'author': data.get('user', {}).get('name', 'Unknown'),
                'username': data.get('user', {}).get('screen_name', 'Unknown'),
                'text': data.get('text', ''),
                'created_at': data.get('created_at', ''),
                'likes': data.get('favorite_count', 0),
                'retweets': data.get('retweet_count', 0),
            }
    except Exception as e:
        return {'error': str(e)}
    return None

def method_fxtwitter(tweet_id, username='i'):
    """Try FXTwitter/FixupX API"""
    try:
        url = f"https://api.fxtwitter.com/{username}/status/{tweet_id}"
        result = subprocess.run(
            ['curl', '-s', '-L', '-H', 'User-Agent: Mozilla/5.0', url],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0 and result.stdout:
            data = json.loads(result.stdout)
            tweet = data.get('tweet', {})
            return {
                'method': 'fxtwitter',
                'author': tweet.get('author', {}).get('name', 'Unknown'),
                'username': tweet.get('author', {}).get('screen_name', 'Unknown'),
                'text': tweet.get('text', ''),
                'created_at': tweet.get('created_at', ''),
                'likes': tweet.get('likes', 0),
                'retweets': tweet.get('retweets', 0),
            }
    except Exception as e:
        return {'error': str(e)}
    return None

def method_vxtwitter(tweet_id, username='i'):
    """Try VXTwitter API"""
    try:
        url = f"https://api.vxtwitter.com/{username}/status/{tweet_id}"
        result = subprocess.run(
            ['curl', '-s', '-L', '-H', 'User-Agent: Mozilla/5.0', url],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0 and result.stdout:
            data = json.loads(result.stdout)
            return {
                'method': 'vxtwitter',
                'author': data.get('user_name', 'Unknown'),
                'username': data.get('user_screen_name', 'Unknown'),
                'text': data.get('text', ''),
                'created_at': data.get('date', ''),
                'likes': data.get('likes', 0),
                'retweets': data.get('retweets', 0),
            }
    except Exception as e:
        return {'error': str(e)}
    return None

def read_tweet(url):
    """Try multiple methods to read tweet"""
    tweet_id = extract_tweet_id(url)
    if not tweet_id:
        return {'error': 'Invalid tweet URL'}
    
    # Extract username from URL if available
    match = re.search(r'x\.com/(\w+)/status', url) or re.search(r'twitter\.com/(\w+)/status', url)
    username = match.group(1) if match else 'i'
    
    # Try methods in order
    methods = [
        ('syndication', lambda: method_syndication(tweet_id)),
        ('fxtwitter', lambda: method_fxtwitter(tweet_id, username)),
        ('vxtwitter', lambda: method_vxtwitter(tweet_id, username)),
    ]
    
    for name, method in methods:
        result = method()
        if result and 'text' in result and result['text']:
            return result
    
    return {'error': 'All methods failed'}

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: x-reader.py <tweet_url>")
        sys.exit(1)
    
    result = read_tweet(sys.argv[1])
    print(json.dumps(result, indent=2, ensure_ascii=False))
