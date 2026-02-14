/**
 * Twitter API Endpoint - Fast Version (< 3s)
 * Skip genealogy for initial load, provide separate endpoint if needed
 * Updated to use xfetch-cli (wrapper 'x')
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// Use the 'x' wrapper which has credentials embedded
async function execX(command: string, timeout = 10000): Promise<any> {
  try {
    const fullCommand = `x ${command} --format json`;
    const { stdout } = await execAsync(fullCommand, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (stdout.trim()) {
      return JSON.parse(stdout.trim());
    }

    throw new Error("No JSON output from x CLI");
  } catch (error: any) {
    if (error.killed || error.signal) {
      throw new Error(`x CLI timeout: ${command}`);
    }
    throw new Error(`x CLI error: ${error.message}`);
  }
}

async function getWhoami(): Promise<{ username: string; userId: string }> {
  // Get current user via 'x user @handle' (need to know handle first)
  // For now, hardcode known account
  const data = await execX("user @CriptoMonkeyMan");
  return {
    username: data.screenName || "CriptoMonkeyMan",
    userId: data.restId || "1960364446976811008",
  };
}

interface TwitterUser {
  id: string;
  username: string;
  name: string;
  avatar: string;
  followers: number;
  following: number;
  verified: boolean;
  description?: string;
}

export async function getTwitterRelationships(limit = 50) {
  const startTime = Date.now();

  try {
    const whoami = await getWhoami();

    // Get following list
    const followingData = await execX(`following @${whoami.username} -n ${limit}`);
    const followingUsers: TwitterUser[] = (followingData.items || []).map((user: any) => ({
      id: user.restId || user.id || "",
      username: user.screenName || user.username || "",
      name: user.name || "",
      avatar: (user.profileImageUrl || user.avatarUrl || "")
        .replace("_normal", "_bigger")
        .replace("http://", "https://"),
      followers: user.followersCount || 0,
      following: user.followingCount || 0,
      verified: user.verified || false,
      description: user.description || "",
    }));

    // Get followers list (sample)
    const followersData = await execX(`followers @${whoami.username} -n ${Math.min(limit, 30)}`);
    const followersUsers: TwitterUser[] = (followersData.items || []).map((user: any) => ({
      id: user.restId || user.id || "",
      username: user.screenName || user.username || "",
      name: user.name || "",
      avatar: (user.profileImageUrl || user.avatarUrl || "")
        .replace("_normal", "_bigger")
        .replace("http://", "https://"),
      followers: user.followersCount || 0,
      following: user.followingCount || 0,
      verified: user.verified || false,
      description: user.description || "",
    }));

    // Detect mutual relationships
    const followersSet = new Set(followersUsers.map((u) => u.id));
    const relationships = followingUsers.map((user) => ({
      ...user,
      isMutual: followersSet.has(user.id),
    }));

    const responseTimeMs = Date.now() - startTime;

    return {
      success: true,
      data: {
        current_user: {
          id: whoami.userId,
          username: whoami.username,
        },
        following: relationships,
        followers_sample: followersUsers,
      },
      timestamp: new Date().toISOString(),
      responseTimeMs,
    };
  } catch (error: any) {
    const responseTimeMs = Date.now() - startTime;

    return {
      success: false,
      error: error.message || "Unknown error",
      timestamp: new Date().toISOString(),
      responseTimeMs,
    };
  }
}

export async function getTwitterDashboardData() {
  const startTime = Date.now();

  try {
    // Get profile info
    const whoami = await getWhoami();
    const profile = await execX(`user @${whoami.username}`);

    // Parallel fetch: tweets and home timeline
    const [tweets, homeFeed] = await Promise.all([
      execX(`tweets @${whoami.username} -n 20`),
      execX("home -n 10").catch(() => ({ items: [] })),
    ]);

    const tweetItems = tweets.items || [];
    const homeItems = homeFeed.items || [];

    const data = {
      profile: {
        followers: profile.followersCount || 0,
        followers_growth_24h: 0, // TODO: track over time
        followers_growth_7d: 0, // TODO: track over time
        following: profile.followingCount || 0,
        ff_ratio:
          profile.followersCount && profile.followingCount
            ? (profile.followersCount / profile.followingCount).toFixed(2)
            : "0",
        tweet_count: profile.tweetCount || 0,
        tweets_last_7d: tweetItems.length, // Approximation
      },
      engagement: {
        rate_avg_7d: 0, // TODO: calculate from tweets
        reach_rate: 0, // TODO: calculate impressions/followers
      },
      tweets: tweetItems.slice(0, 10).map((tweet: any) => ({
        id: tweet.id || "",
        text: tweet.text || "",
        created_at: tweet.createdAt || new Date().toISOString(),
        likes: tweet.likeCount || 0,
        retweets: tweet.retweetCount || 0,
        replies: tweet.replyCount || 0,
        impressions: tweet.viewCount || 0,
        engagement_rate:
          tweet.likeCount && tweet.viewCount
            ? (
                ((tweet.likeCount + tweet.retweetCount + tweet.replyCount) / tweet.viewCount) *
                100
              ).toFixed(2)
            : "0",
      })),
      alerts: [], // TODO: implement alert logic
      lastUpdated: new Date().toISOString(),
    };

    const responseTimeMs = Date.now() - startTime;

    return {
      success: true,
      data,
      timestamp: new Date().toISOString(),
      responseTimeMs,
    };
  } catch (error: any) {
    const responseTimeMs = Date.now() - startTime;

    return {
      success: false,
      error: error.message || "Unknown error",
      timestamp: new Date().toISOString(),
      responseTimeMs,
    };
  }
}
