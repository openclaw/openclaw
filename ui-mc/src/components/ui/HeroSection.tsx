import { motion } from "framer-motion";
import { ReactNode } from "react";

interface HeroSectionProps {
  title: string;
  subtitle: string;
  children?: ReactNode;
}

export function HeroSection({ title, subtitle, children }: HeroSectionProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="glass-panel p-6 mb-6"
    >
      <h1 className="text-3xl font-extralight tracking-wide text-foreground mb-1">{title}</h1>
      <p className="text-text-2 text-sm font-mono">{subtitle}</p>
      {children && <div className="flex gap-3 mt-4">{children}</div>}
    </motion.div>
  );
}
