export function getRelativeTimeDescription(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30.44);
  const years = months / 12;

  // Format the exact date suffix (e.g. "9 Feb" or "9 Feb 2023")
  const sameYear = date.getFullYear() === now.getFullYear();
  const dateSuffix = date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
  });

  let sensation: string;

  if (seconds < 60) {
    return "just now";
  } else if (minutes < 30) {
    sensation = "a moment ago";
  } else if (hours < 2) {
    sensation = "a while ago";
  } else if (hours < 6) {
    sensation = "a few hours ago";
  } else if (hours < 18) {
    sensation = "earlier today";
  } else if (hours < 30) {
    sensation = "yesterday";
  } else if (days < 4) {
    sensation = "a few days ago";
  } else if (days < 10) {
    sensation = "last week";
  } else if (days < 20) {
    sensation = "a couple of weeks ago";
  } else if (months < 2) {
    sensation = "last month";
  } else if (days < 75) {
    sensation = "a couple of months ago";
  } else if (days < 100) {
    sensation = "about three months ago";
  } else if (days < 130) {
    sensation = "a few months back";
  } else if (days < 160) {
    sensation = "about four months ago";
  } else if (months < 6) {
    sensation = "five months ago or so";
  } else if (months < 10) {
    sensation = "several months ago";
  } else if (months < 14) {
    sensation = "last year";
  } else {
    // Year-level granularity
    const wholeYears = Math.floor(years);
    const remainingMonths = months - wholeYears * 12;

    if (wholeYears === 1 && remainingMonths < 2) {
      sensation = "about a year ago";
    } else if (wholeYears === 1 && remainingMonths < 8) {
      sensation = "over a year ago";
    } else if (wholeYears === 1) {
      sensation = "almost two years ago";
    } else {
      const n = wholeYears;
      if (remainingMonths < 2) {
        sensation = `${n} years ago`;
      } else if (remainingMonths < 5) {
        sensation = `over ${n} years ago`;
      } else {
        sensation = `almost ${n + 1} years ago`;
      }
    }
  }

  return `${sensation} — ${dateSuffix}`;
}
