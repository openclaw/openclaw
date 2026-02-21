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
  const dateSuffix = date.toLocaleDateString("es-ES", {
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
  });

  let sensation: string;

  if (seconds < 60) {
    return "justo ahora";
  } else if (minutes < 30) {
    sensation = "hace un momento";
  } else if (hours < 2) {
    sensation = "hace un rato";
  } else if (hours < 6) {
    sensation = "hace unas horas";
  } else if (hours < 18) {
    sensation = "hoy más temprano";
  } else if (hours < 30) {
    sensation = "ayer";
  } else if (days < 4) {
    sensation = "hace unos días";
  } else if (days < 10) {
    sensation = "la semana pasada";
  } else if (days < 20) {
    sensation = "hace unas semanas";
  } else if (months < 2) {
    sensation = "hace un mes";
  } else if (months < 3) {
    sensation = "hace un par de meses";
  } else if (months < 6) {
    sensation = "hace varios meses";
  } else if (months < 11) {
    sensation = "hace casi 1 año";
  } else {
    // Year-level granularity: N años, N años y algo, casi N+1 años
    const wholeYears = Math.floor(years);
    const remainingMonths = months - wholeYears * 12;

    if (wholeYears === 1 && remainingMonths < 3) {
      sensation = "hace 1 año";
    } else if (wholeYears === 1 && remainingMonths < 9) {
      sensation = "hace 1 año y algo";
    } else {
      // For 2+ years
      const n = wholeYears;
      if (remainingMonths < 2) {
        sensation = `hace ${n} años`;
      } else if (remainingMonths < 7) {
        sensation = `hace ${n} años y algo`;
      } else {
        sensation = `hace casi ${n + 1} años`;
      }
    }
  }

  return `${sensation} — ${dateSuffix}`;
}
