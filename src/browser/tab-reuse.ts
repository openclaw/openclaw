/**
 * Intelligent Tab Reuse
 * 
 * Reuses existing browser tabs instead of opening duplicates.
 * Searches for tabs by exact URL or domain match.
 */

export type TabReuseConfig = {
  enabled: boolean;
  matchDomain: boolean;
  matchExact: boolean;
  focusExisting: boolean;
};

export type TabInfo = {
  targetId: string;
  url: string;
  title?: string;
  type?: string;
};

export type TabReuseOptions = {
  forceNew?: boolean;
  matchDomain?: boolean;
};

export type TabReuseResult = {
  targetId: string;
  reused: boolean;
  reason?: string;
};

const DEFAULT_CONFIG: TabReuseConfig = {
  enabled: true,
  matchDomain: true,
  matchExact: true,
  focusExisting: true,
};

/**
 * Extract hostname from URL safely
 */
function getHostname(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return null;
  }
}

/**
 * Check if two URLs match exactly
 */
function urlsMatch(url1: string, url2: string): boolean {
  try {
    // Normalize URLs by removing trailing slashes and fragments
    const normalize = (url: string) => {
      const parsed = new URL(url);
      parsed.hash = '';
      let href = parsed.href;
      if (href.endsWith('/')) {
        href = href.slice(0, -1);
      }
      return href;
    };
    
    return normalize(url1) === normalize(url2);
  } catch {
    // If parsing fails, do simple string comparison
    return url1.trim() === url2.trim();
  }
}

/**
 * Check if two URLs have the same domain
 */
function domainsMatch(url1: string, url2: string): boolean {
  const host1 = getHostname(url1);
  const host2 = getHostname(url2);
  
  if (!host1 || !host2) {
    return false;
  }
  
  return host1 === host2;
}

/**
 * Find existing tab that matches the target URL
 */
export function findMatchingTab(
  targetUrl: string,
  existingTabs: TabInfo[],
  config: TabReuseConfig
): TabInfo | null {
  if (!config.enabled || existingTabs.length === 0) {
    return null;
  }
  
  // Filter to only page tabs (not background, serviceworker, etc.)
  const pageTabs = existingTabs.filter(tab => 
    !tab.type || tab.type === 'page'
  );
  
  // Try exact URL match first (highest priority)
  if (config.matchExact) {
    const exactMatch = pageTabs.find(tab => 
      urlsMatch(tab.url, targetUrl)
    );
    
    if (exactMatch) {
      return exactMatch;
    }
  }
  
  // Try domain match (lower priority)
  if (config.matchDomain) {
    const domainMatch = pageTabs.find(tab => 
      domainsMatch(tab.url, targetUrl)
    );
    
    if (domainMatch) {
      return domainMatch;
    }
  }
  
  return null;
}

/**
 * Decide whether to reuse existing tab or open new one
 */
export function shouldReuseTab(
  targetUrl: string,
  existingTabs: TabInfo[],
  options: TabReuseOptions = {},
  config: TabReuseConfig = DEFAULT_CONFIG
): { reuse: boolean; matchedTab?: TabInfo; reason: string } {
  // If force new, always open new tab
  if (options.forceNew) {
    return {
      reuse: false,
      reason: 'forceNew option set',
    };
  }
  
  // If reuse disabled, always open new
  if (!config.enabled) {
    return {
      reuse: false,
      reason: 'tab reuse disabled in config',
    };
  }
  
  // Merge options with config
  const effectiveConfig: TabReuseConfig = {
    ...config,
    matchDomain: options.matchDomain ?? config.matchDomain,
  };
  
  // Try to find matching tab
  const matchedTab = findMatchingTab(targetUrl, existingTabs, effectiveConfig);
  
  if (matchedTab) {
    const matchType = urlsMatch(matchedTab.url, targetUrl) 
      ? 'exact URL' 
      : 'same domain';
    
    return {
      reuse: true,
      matchedTab,
      reason: `found ${matchType} match`,
    };
  }
  
  return {
    reuse: false,
    reason: 'no matching tab found',
  };
}

/**
 * Format tab reuse decision for logging
 */
export function formatReuseDecision(
  targetUrl: string,
  result: { reuse: boolean; matchedTab?: TabInfo; reason: string }
): string {
  if (result.reuse && result.matchedTab) {
    return `Reusing tab ${result.matchedTab.targetId} for ${targetUrl} (${result.reason})`;
  }
  
  return `Opening new tab for ${targetUrl} (${result.reason})`;
}

/**
 * Get default tab reuse configuration
 */
export function getDefaultConfig(): TabReuseConfig {
  return { ...DEFAULT_CONFIG };
}
