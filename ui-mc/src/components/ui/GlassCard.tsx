import { motion } from "framer-motion";
import { ReactNode } from "react";

interface GlassCardProps {
  children: ReactNode;
  className?: string;
  hover?: boolean;
}

export function GlassCard({ children, className = "", hover = true }: GlassCardProps) {
  return (
    <motion.div
      className={`glass-panel ${className}`}
      whileHover={
        hover
          ? {
              y: -2,
              boxShadow:
                "0 0 0 1px rgba(255,255,255,0.08) inset, 0 24px 70px rgba(0,0,0,0.7), 0 0 140px rgba(0,200,255,0.05)",
            }
          : undefined
      }
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
    >
      {children}
    </motion.div>
  );
}
